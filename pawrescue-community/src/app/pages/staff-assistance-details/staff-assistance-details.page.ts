import { CommonModule } from '@angular/common';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Component, OnDestroy, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  HttpClient,
  HttpErrorResponse,
  HttpHeaders,
  HttpParams
} from '@angular/common/http';
import { ActivatedRoute, Router } from '@angular/router';
import { IonContent, IonIcon, IonSpinner } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  arrowBackOutline,
  refreshOutline,
  pawOutline,
  heartOutline,
  alertCircleOutline,
  locationOutline,
  calendarOutline,
  personOutline,
  documentTextOutline,
  imageOutline,
  timeOutline,
  checkmarkCircleOutline,
  saveOutline
} from 'ionicons/icons';
import { Subscription } from 'rxjs';

import { getApiBaseUrl } from '../../config/ip-config';
import { AuthService } from '../../services/auth';
import type {
  AssistanceStatus,
  StaffAssistanceCase
} from '../staff-animal-assistance/staff-animal-assistance.page';

// ============================================================
// PAWCONNECT — STAFF ANIMAL ASSISTANCE CASE DETAILS + MANAGEMENT
// ============================================================
// Cases originate from residents' EXISTING Found Pet reports.
// This staff-only page can view a case and update its assistance
// status / assessment notes without editing the Found Pet report.
//
// GET  /animal_assistance/get_cases.php?case_id=<id>&limit=1&offset=0
// POST /animal_assistance/update_case.php
// Route: /staff-animal-assistance/:id (protected by staffGuard)
//
// Rescue completion uses multipart/form-data with a required proof photo.
// The matching HTML and SCSS will be updated one file at a time.
// ============================================================

// The management list still has the historical status type. This page
// understands the new Rescued status without requiring an unrelated file edit.
type CaseStatus = AssistanceStatus | 'rescued';
type RescueAssistanceCase = Omit<StaffAssistanceCase, 'status'> & {
  status: CaseStatus;
  rescue_proof_path?: string | null;
  rescue_note?: string | null;
  rescued_at?: string | null;
  rescued_by_user_id?: number | null;
};

interface GetCaseDetailsResponse {
  success: boolean;
  message: string;
  total: number;
  cases: RescueAssistanceCase[];
}

interface UpdatedCaseResult {
  id: number;
  found_report_id: number;
  previous_status: CaseStatus;
  status: CaseStatus;
  staff_notes: string | null;
  reviewed_at: string | null;
  resolved_at: string | null;
  rescue_proof_path: string | null;
  rescue_note: string | null;
  rescued_at: string | null;
  rescued_by_user_id: number | null;
  updated_at: string;
}

interface UpdateCaseResponse {
  success: boolean;
  message: string;
  case: UpdatedCaseResult;
}

// Use Capacitor's native Browser bridge for external map links.
// This does not add a TypeScript dependency on @capacitor/browser;
// the matching native plugin must still be installed/synced in Android.
interface NativeBrowserBridge {
  open(options: { url: string }): Promise<void>;
}
const NativeBrowser = registerPlugin<NativeBrowserBridge>('Browser');

// Newly submitted cases: Pending -> Rescued.
// Legacy open cases can also be completed using the same proof requirement.
const NEXT_STATUS: Record<CaseStatus, CaseStatus | null> = {
  pending: 'rescued',
  under_review: 'rescued',
  in_progress: 'rescued',
  resolved: null,
  rescued: null
};

@Component({
  selector: 'app-staff-assistance-details',
  templateUrl: './staff-assistance-details.page.html',
  styleUrls: ['./staff-assistance-details.page.scss'],
  standalone: true,
  imports: [CommonModule, FormsModule, IonContent, IonIcon, IonSpinner]
})
export class StaffAssistanceDetailsPage implements OnDestroy {
  private readonly http = inject(HttpClient);
  private readonly authService = inject(AuthService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  private readonly apiBaseUrl = getApiBaseUrl().replace(/\/$/, '');
  private readonly casesEndpoint =
    `${this.apiBaseUrl}/animal_assistance/get_cases.php`;
  private readonly updateEndpoint =
    `${this.apiBaseUrl}/animal_assistance/update_case.php`;

  private caseSubscription?: Subscription;
  private updateSubscription?: Subscription;
  private requestVersion = 0;

  caseId: number | null = null;
  assistanceCase: RescueAssistanceCase | null = null;
  photoUrl: string | null = null;
  loading = false;
  errorMessage = '';
  lastUpdated: Date | null = null;

  // Presentation-only state for the photo lightbox and external map link.
  photoViewerOpen = false;
  mapErrorMessage = '';

  // Rescue evidence and preview for the selected case.
  readonly maxRescueProofBytes = 5 * 1024 * 1024;
  readonly rescueProofAccept = 'image/jpeg,image/png,image/webp';
  rescueProofFile: File | null = null;
  rescueProofPreviewUrl: string | null = null;
  rescueProofUrl: string | null = null;
  rescueProofViewerOpen = false;
  rescueProofErrorMessage = '';

  // Status options follow the server: current status or Rescued.
  selectedStatus: CaseStatus = 'pending';
  statusOptions: CaseStatus[] = [];
  assessmentNote = '';
  readonly maxAssessmentNoteLength = 2000;
  saving = false;
  updateErrorMessage = '';
  updateSuccessMessage = '';

  constructor() {
    addIcons({
      arrowBackOutline,
      refreshOutline,
      pawOutline,
      heartOutline,
      alertCircleOutline,
      locationOutline,
      calendarOutline,
      personOutline,
      documentTextOutline,
      imageOutline,
      timeOutline,
      checkmarkCircleOutline,
      saveOutline
    });
  }

  // A photo opens in a fitted on-page viewer, not as a raw image URL.
  openPhotoViewer(): void {
    if (this.photoUrl) {
      this.photoViewerOpen = true;
    }
  }

  closePhotoViewer(): void {
    this.photoViewerOpen = false;
  }

  openRescueProofViewer(): void {
    if (this.rescueProofUrl) {
      this.rescueProofViewerOpen = true;
    }
  }

  closeRescueProofViewer(): void {
    this.rescueProofViewerOpen = false;
  }

  // Uses the phone's native file picker/camera choices through the HTML input.
  // The server independently checks the MIME type and real image contents.
  onRescueProofSelected(event: Event): void {
    const input = event.target as HTMLInputElement | null;
    const file = input?.files?.[0] ?? null;
    this.clearRescueProofSelection();
    this.rescueProofErrorMessage = '';
    this.updateErrorMessage = '';

    if (!file) {
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      this.rescueProofErrorMessage = 'Select a JPG, PNG, or WEBP rescue photo.';
      if (input) input.value = '';
      return;
    }
    if (file.size <= 0 || file.size > this.maxRescueProofBytes) {
      this.rescueProofErrorMessage = 'Rescue proof photo must be 5 MB or smaller.';
      if (input) input.value = '';
      return;
    }

    this.rescueProofFile = file;
    this.rescueProofPreviewUrl = URL.createObjectURL(file);
  }

  clearRescueProofSelection(input?: HTMLInputElement): void {
    if (input) {
      input.value = '';
    }
    if (this.rescueProofPreviewUrl) {
      URL.revokeObjectURL(this.rescueProofPreviewUrl);
    }
    this.rescueProofFile = null;
    this.rescueProofPreviewUrl = null;
  }

  // External Google Maps should not be opened by a target=_blank link
  // inside a native Android WebView.
  async viewLocationOnMap(item: RescueAssistanceCase): Promise<void> {
    this.mapErrorMessage = '';

    if (!this.hasCoordinates(item) ||
        item.latitude! < -90 || item.latitude! > 90 ||
        item.longitude! < -180 || item.longitude! > 180) {
      this.mapErrorMessage = 'Valid GPS coordinates are not available for this case.';
      return;
    }

    const url = 'https://www.google.com/maps/search/?api=1&query=' +
      encodeURIComponent(`${item.latitude},${item.longitude}`);

    try {
      if (Capacitor.isNativePlatform()) {
        await NativeBrowser.open({ url });
      } else {
        const externalTab = window.open(url, '_blank');
        if (!externalTab) {
          this.mapErrorMessage = 'Your browser blocked Maps. Allow pop-ups and try again.';
          return;
        }
        externalTab.opener = null;
      }
    } catch (error) {
      console.warn('[PawConnect] Unable to open reported GPS coordinates in Maps:', error);
      this.mapErrorMessage =
        'Unable to open Maps. On Android, check that the Capacitor Browser plugin is installed and synced.';
    }
  }

  ionViewWillLeave(): void {
    this.closePhotoViewer();
    this.closeRescueProofViewer();
  }

  // Ionic may cache this component; refresh when staff return.
  ionViewWillEnter(): void {
    this.loadCase();
  }

  loadCase(): void {
    // Do not replace form data while an update is being submitted.
    if (this.saving) {
      return;
    }

    this.closePhotoViewer();
    this.closeRescueProofViewer();
    this.mapErrorMessage = '';

    const idParam = this.route.snapshot.paramMap.get('id');
    const parsedId = idParam && /^\d+$/.test(idParam)
      ? Number(idParam)
      : NaN;

    // Matches the INT UNSIGNED case ID validation in PHP.
    if (!Number.isSafeInteger(parsedId) || parsedId < 1 || parsedId > 4294967295) {
      this.caseSubscription?.unsubscribe();
      this.requestVersion++;
      this.errorMessage = 'Invalid assistance case ID.';
      this.caseId = null;
      this.assistanceCase = null;
      this.photoUrl = null;
      this.rescueProofUrl = null;
      this.clearRescueProofSelection();
      this.loading = false;
      this.statusOptions = [];
      return;
    }

    const token = this.authService.getToken();
    if (!token) {
      void this.router.navigateByUrl('/login', { replaceUrl: true });
      return;
    }

    this.caseSubscription?.unsubscribe();
    const currentVersion = ++this.requestVersion;

    // Clear an older case when navigating to a different case ID.
    if (this.caseId !== parsedId) {
      this.assistanceCase = null;
      this.photoUrl = null;
      this.rescueProofUrl = null;
      this.clearRescueProofSelection();
      this.statusOptions = [];
      this.assessmentNote = '';
    }

    this.caseId = parsedId;
    this.loading = true;
    this.errorMessage = '';
    this.updateErrorMessage = '';
    this.updateSuccessMessage = '';

    const params = new HttpParams()
      .set('case_id', String(parsedId))
      .set('limit', '1')
      .set('offset', '0');

    const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });

    this.caseSubscription = this.http.get<GetCaseDetailsResponse>(
      this.casesEndpoint,
      { headers, params }
    ).subscribe({
      next: (response) => {
        if (currentVersion !== this.requestVersion ||
            this.authService.getToken() !== token) {
          return;
        }

        this.loading = false;

        if (!response?.success || !Array.isArray(response.cases)) {
          this.errorMessage = response?.message || 'Unable to load this case.';
          return;
        }

        const item = response.cases.find((entry) => entry.id === parsedId);
        if (!item) {
          this.assistanceCase = null;
          this.photoUrl = null;
          this.rescueProofUrl = null;
          this.clearRescueProofSelection();
          this.statusOptions = [];
          this.errorMessage = 'This assistance case was not found.';
          return;
        }

        this.assistanceCase = item;
        this.photoUrl = this.resolvePhotoUrl(item.photo_path);
        this.rescueProofUrl = this.resolveRescueProofUrl(item.rescue_proof_path ?? null);
        this.lastUpdated = new Date();
        this.resetEditor(item.status);
      },
      error: (error: HttpErrorResponse) => {
        if (currentVersion !== this.requestVersion) {
          return;
        }

        this.loading = false;
        this.assistanceCase = null;
        this.photoUrl = null;
        this.rescueProofUrl = null;
        this.clearRescueProofSelection();
        this.statusOptions = [];

        // Keep the staff-only route protected by staffGuard, but do not
        // hide the actual API rejection behind an automatic login redirect.
        // No case data is displayed when the request is rejected.
        if (error.status === 401) {
          this.errorMessage =
            'Case Details API returned 401 (Unauthorized). The staff session was rejected. Sign in again, then retry.';
          return;
        }

        if (error.status === 403) {
          this.errorMessage =
            'Case Details API returned 403 (Forbidden). Your staff account was denied access to this case.';
          return;
        }

        if (error.status === 404) {
          this.errorMessage = 'This assistance case was not found.';
        } else if (error.status === 0) {
          this.errorMessage =
            'Cannot connect to the server. Check your connection and try again.';
        } else {
          this.errorMessage =
            'Unable to retrieve the case details. Please try again.';
        }
      }
    });
  }

  refreshCase(): void {
    this.loadCase();
  }

  backToCases(): void {
    if (this.saving) {
      return;
    }
    void this.router.navigateByUrl('/staff-animal-assistance');
  }

  private resetEditor(status: CaseStatus): void {
    this.selectedStatus = status;
    this.assessmentNote = '';
    this.clearRescueProofSelection();
    this.rescueProofErrorMessage = '';
    this.statusOptions = [status];
    const next = NEXT_STATUS[status];
    if (next) {
      this.statusOptions.push(next);
    }
  }

  /** True when this is an allowed change with any required note included. */
  canSaveCaseUpdate(): boolean {
    if (!this.assistanceCase || this.caseId === null ||
        this.loading || this.saving) {
      return false;
    }

    if (!this.statusOptions.includes(this.selectedStatus)) {
      return false;
    }

    const note = this.assessmentNote.trim();
    if (note.length > this.maxAssessmentNoteLength) {
      return false;
    }

    const changedStatus = this.selectedStatus !== this.assistanceCase.status;
    if (!changedStatus && note.length === 0) {
      return false;
    }

    // Both a description and a photo are mandatory for completion.
    if (changedStatus && this.selectedStatus === 'rescued' &&
        (!note || !this.rescueProofFile)) {
      return false;
    }

    return true;
  }

  saveCaseUpdate(): void {
    this.updateErrorMessage = '';
    this.updateSuccessMessage = '';
    this.rescueProofErrorMessage = '';

    const item = this.assistanceCase;
    const token = this.authService.getToken();

    if (!token) {
      void this.router.navigateByUrl('/login', { replaceUrl: true });
      return;
    }

    if (!item || this.caseId === null || this.loading || this.saving) {
      return;
    }

    const note = this.assessmentNote.trim();
    const changedStatus = this.selectedStatus !== item.status;

    if (!this.statusOptions.includes(this.selectedStatus)) {
      this.updateErrorMessage = 'Please select a valid next case status.';
      return;
    }
    if (note.length > this.maxAssessmentNoteLength) {
      this.updateErrorMessage = 'Assessment notes must be 2000 characters or fewer.';
      return;
    }
    if (!changedStatus && !note) {
      this.updateErrorMessage = 'Enter an assessment note or select the next status.';
      return;
    }
    const completingRescue = changedStatus && this.selectedStatus === 'rescued';
    if (completingRescue && !note) {
      this.updateErrorMessage = 'Describe the rescue or assistance before marking this case Rescued.';
      return;
    }
    if (completingRescue && !this.rescueProofFile) {
      this.rescueProofErrorMessage = 'Attach one rescue proof photo before marking this case Rescued.';
      return;
    }

    this.saving = true;
    const requestedCaseId = this.caseId;
    const requestedVersion = this.requestVersion;
    const headers = new HttpHeaders({ Authorization: `Bearer ${token}` });

    // Do not manually set Content-Type for FormData; the browser supplies
    // multipart/form-data with its required boundary.
    let requestBody: FormData | { case_id: number; status: CaseStatus; staff_note: string };
    if (completingRescue) {
      const formData = new FormData();
      formData.append('case_id', String(requestedCaseId));
      formData.append('status', 'rescued');
      formData.append('staff_note', note);
      formData.append('rescue_proof', this.rescueProofFile!, this.rescueProofFile!.name);
      requestBody = formData;
    } else {
      // Existing note-only requests remain JSON for backward compatibility.
      requestBody = {
        case_id: requestedCaseId,
        status: this.selectedStatus,
        staff_note: note
      };
    }

    this.updateSubscription = this.http.post<UpdateCaseResponse>(
      this.updateEndpoint,
      requestBody,
      { headers }
    ).subscribe({
      next: (response) => {
        this.saving = false;
        if (requestedVersion !== this.requestVersion ||
            this.caseId !== requestedCaseId ||
            this.authService.getToken() !== token) {
          return;
        }

        const result = response?.case;
        if (!response?.success || !result || result.id !== requestedCaseId) {
          this.updateErrorMessage = 'The server did not confirm this update. Refresh and try again.';
          return;
        }

        // The response is committed server state, not an optimistic update.
        this.assistanceCase = {
          ...item,
          status: result.status,
          staff_notes: result.staff_notes,
          reviewed_at: result.reviewed_at,
          resolved_at: result.resolved_at,
          rescue_proof_path: result.rescue_proof_path,
          rescue_note: result.rescue_note,
          rescued_at: result.rescued_at,
          rescued_by_user_id: result.rescued_by_user_id,
          updated_at: result.updated_at
        };
        this.rescueProofUrl = this.resolveRescueProofUrl(result.rescue_proof_path);
        this.lastUpdated = new Date();
        this.resetEditor(result.status);
        this.updateSuccessMessage = response.message || 'Case updated successfully.';
      },
      error: (error: HttpErrorResponse) => {
        this.saving = false;
        if (requestedVersion !== this.requestVersion ||
            this.authService.getToken() !== token) {
          return;
        }

        // Do not throw away staff's unsaved notes or mask an API permission
        // problem by immediately navigating away to Login.
        if (error.status === 401) {
          this.updateErrorMessage =
            'Save failed: 401 (Unauthorized). Your staff session was rejected. Sign in again before retrying.';
          return;
        }

        if (error.status === 403) {
          this.updateErrorMessage =
            'Save failed: 403 (Forbidden). This staff account is not permitted to update the case.';
          return;
        }

        // Preserve unsaved notes so staff can retry or refresh intentionally.
        const serverMessage = error.error?.message;
        if (error.status === 409) {
          this.updateErrorMessage = typeof serverMessage === 'string'
            ? `${serverMessage} Refresh this case before trying again.`
            : 'The case may have changed. Refresh it and try again.';
        } else if ([400, 413, 415].includes(error.status) && typeof serverMessage === 'string') {
          this.updateErrorMessage = serverMessage;
        } else if (error.status === 0) {
          this.updateErrorMessage =
            'Cannot connect to the server. Your note was not confirmed as saved. Please check your connection.';
        } else {
          this.updateErrorMessage =
            'Unable to save the case update. Please try again.';
        }
      }
    });
  }

  getAnimalName(item: RescueAssistanceCase): string {
    const petName = item.pet_name?.trim();
    if (petName) {
      return petName;
    }
    return item.animal_type?.toLowerCase() === 'cat'
      ? 'Found Cat'
      : 'Found Dog';
  }

  getAnimalType(item: RescueAssistanceCase): string {
    return item.animal_type?.toLowerCase() === 'cat' ? 'Cat' : 'Dog';
  }

  getStatusLabel(status: CaseStatus): string {
    const labels: Record<CaseStatus, string> = {
      pending: 'Pending',
      under_review: 'Under Review',
      in_progress: 'In Progress',
      resolved: 'Resolved',
      rescued: 'Rescued'
    };
    return labels[status] || 'Unknown';
  }

  getReasonLabel(reason: string): string {
    const labels: Record<string, string> = {
      injured: 'Injured',
      sick: 'Sick',
      trapped: 'Trapped',
      aggressive: 'Safety Concern'  ,
      abandoned: 'Possibly Abandoned',
      roaming: 'Roaming / Unattended',
      other: 'Other Concern'
    };
    return labels[reason] || 'Animal Assistance';
  }

  hasCoordinates(item: RescueAssistanceCase): boolean {
    return item.latitude !== null && item.longitude !== null &&
      Number.isFinite(item.latitude) && Number.isFinite(item.longitude);
  }

  /**
   * Map known pet upload filenames to the configured PHP API.
   * Reject arbitrary server-provided image URLs.
   * Older PawRescue upload paths remain supported by filename.
   */
  private resolvePhotoUrl(photoPath: string | null): string | null {
    if (!photoPath || typeof photoPath !== 'string') {
      return null;
    }

    const normalized = photoPath.trim().replace(/\\/g, '/');
    const match = normalized.match(
      /(?:^|\/)uploads\/pets\/([a-f0-9]{32}\.(?:jpg|jpeg|png|webp))$/i
    );

    if (!match) {
      return null;
    }

    return `${this.apiBaseUrl}/uploads/pets/${match[1]}`;
  }

  // The server returns a relative path, never a trusted arbitrary URL.
  private resolveRescueProofUrl(proofPath: string | null): string | null {
    if (!proofPath || typeof proofPath !== 'string') {
      return null;
    }
    const normalized = proofPath.trim().replace(/\\/g, '/');
    const match = normalized.match(
      /(?:^|\/)uploads\/rescue_proofs\/([a-f0-9]{32}\.(?:jpg|jpeg|png|webp))$/i
    );
    return match ? `${this.apiBaseUrl}/uploads/rescue_proofs/${match[1]}` : null;
  }

  ngOnDestroy(): void {
    this.clearRescueProofSelection();
    this.closeRescueProofViewer();
    this.closePhotoViewer();
    this.requestVersion++;
    this.caseSubscription?.unsubscribe();
    this.updateSubscription?.unsubscribe();
  }
}
