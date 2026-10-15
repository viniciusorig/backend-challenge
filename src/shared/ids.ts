/** Time-ordered UUID (v7): index friendly and sortable by creation time. */
export function newId(): string {
  return Bun.randomUUIDv7();
}
