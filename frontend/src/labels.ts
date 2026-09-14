export const STATUS_LABELS: Record<string, string> = {
  NEW: 'New',
  IN_PROGRESS_ESTIMATION: 'In Progress Estimation',
  IN_PROGRESS_TENDER: 'In Progress Tender',
  DONE: 'Done',
  HOLD: 'Hold',
};
export const STATUSES = Object.keys(STATUS_LABELS);

export const TYPE_LABELS: Record<string, string> = {
  PROJECT_TENDER: 'Project Tender',
  OPS_TENDER: 'Ops Tender',
  SITE_INSTRUCTION: 'Site Instruction / Memo',
  BUDGETING_INTERNAL: 'Budgeting Internal',
};
export const TYPE_SHORT: Record<string, string> = {
  PROJECT_TENDER: 'Proj. Tender',
  OPS_TENDER: 'Ops Tender',
  SITE_INSTRUCTION: 'Site Instr.',
  BUDGETING_INTERNAL: 'Budgeting',
};
export const TYPES = Object.keys(TYPE_LABELS);

export const PRIORITY_LABELS: Record<string, string> = { URGENT: 'Urgent', NORMAL: 'Normal', LOW: 'Low' };
export const PRIORITIES = Object.keys(PRIORITY_LABELS);

export const SOURCE_LABELS: Record<string, string> = { WHATSAPP: 'WhatsApp', EMAIL: 'Email', VERBAL: 'Verbal / meeting' };
export const SOURCES = Object.keys(SOURCE_LABELS);

export const TENDER_STATUS_LABELS: Record<string, string> = {
  SUBMITTED: 'Submitted', WON: 'Won', LOST: 'Lost', CANCELLED: 'Cancelled',
};

export const AV_PALETTE = ['#2D5BE3', '#8B5CF6', '#0D9488', '#D97706', '#DC2626', '#059669', '#7C3AED', '#C026D3', '#0369A1'];

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function fmtDate(d?: string | null): string {
  if (!d) return '—';
  const date = new Date(d.length === 10 ? d + 'T00:00:00' : d);
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function fmtDateTime(d?: string | null): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
