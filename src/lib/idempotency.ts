export function buildDateScopedReminderIdempotencyKey(
  reminderType: string,
  nrContrato: string | null,
  referenceDate: string,
): string {
  return `${reminderType.trim()}:${String(nrContrato || "").trim()}:${referenceDate.trim()}`;
}

export function buildOfferReminderIdempotencyKey(
  reminderType: string,
  nrContrato: string | null,
): string {
  return `${reminderType.trim()}:${String(nrContrato || "").trim()}`;
}
