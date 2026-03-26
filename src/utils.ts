export interface RangeOptions {
  gt?: string
  gte?: string
  lt?: string
  lte?: string
  reverse?: boolean
  limit?: number
}

/**
 * Build a paginated SELECT query using cursor-based pagination.
 * lastKey is the last key seen from the previous page (null on first fetch).
 */
export function buildRangeSQL(
  table: string,
  options: RangeOptions,
  lastKey: string | null,
  pageSize: number
): { sql: string; params: Array<string | number> } {
  const { gt, gte, lt, lte, reverse = false } = options
  const conditions: string[] = []
  const params: Array<string | number> = []

  // Lower bound
  if (gte !== undefined) {
    conditions.push('key >= ?')
    params.push(gte)
  } else if (gt !== undefined) {
    conditions.push('key > ?')
    params.push(gt)
  }

  // Upper bound
  if (lte !== undefined) {
    conditions.push('key <= ?')
    params.push(lte)
  } else if (lt !== undefined) {
    conditions.push('key < ?')
    params.push(lt)
  }

  // Cursor: exclude already-seen entries
  if (lastKey !== null) {
    conditions.push(reverse ? 'key < ?' : 'key > ?')
    params.push(lastKey)
  }

  let sql = `SELECT key, value FROM "${table}"`
  if (conditions.length > 0) {
    sql += ` WHERE ${conditions.join(' AND ')}`
  }
  sql += ` ORDER BY key ${reverse ? 'DESC' : 'ASC'}`
  sql += ` LIMIT ?`
  params.push(pageSize)

  return { sql, params }
}

/**
 * Build a DELETE query with optional range and limit constraints.
 * Uses a subquery for LIMIT support (D1 may not have SQLITE_ENABLE_UPDATE_DELETE_LIMIT).
 */
export function buildClearSQL(
  table: string,
  options: RangeOptions
): { sql: string; params: Array<string | number> } {
  const { gt, gte, lt, lte, limit, reverse = false } = options
  const conditions: string[] = []
  const params: Array<string | number> = []

  if (gte !== undefined) {
    conditions.push('key >= ?')
    params.push(gte)
  } else if (gt !== undefined) {
    conditions.push('key > ?')
    params.push(gt)
  }

  if (lte !== undefined) {
    conditions.push('key <= ?')
    params.push(lte)
  } else if (lt !== undefined) {
    conditions.push('key < ?')
    params.push(lt)
  }

  const whereClause = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : ''

  if (limit !== undefined && isFinite(limit)) {
    const order = reverse ? 'DESC' : 'ASC'
    const sql = `DELETE FROM "${table}" WHERE key IN (SELECT key FROM "${table}"${whereClause} ORDER BY key ${order} LIMIT ?)`
    return { sql, params: [...params, limit] }
  }

  return { sql: `DELETE FROM "${table}"${whereClause}`, params }
}
