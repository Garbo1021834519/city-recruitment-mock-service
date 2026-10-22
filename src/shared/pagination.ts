export interface Pagination { page: number; pageSize: number; offset: number }

function positiveInteger(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function parsePagination(query: Record<string, unknown>): Pagination {
  const page = positiveInteger(query.page, 1);
  const pageSize = Math.min(1000, positiveInteger(query.page_size ?? query.pageSize, 20));
  return { page, pageSize, offset: (page - 1) * pageSize };
}
