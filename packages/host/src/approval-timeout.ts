// The words every approval-timeout denial carries. The approval service
// writes them into the denial reason and the run classifies a denial as
// timed out by finding them, so both read this one constant.
export const TIMEOUT_REASON_MARKER = 'timed out';
