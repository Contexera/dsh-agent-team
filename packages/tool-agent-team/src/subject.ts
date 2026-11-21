const SUBJECT_BOUND = 80

/** Keep the directory subject and Thread orientation identical. */
export function boundedSubject(body: string): string {
  const collapsed = body.replaceAll(/\s+/gu, ' ').trim()
  return collapsed.length <= SUBJECT_BOUND ? collapsed : `${collapsed.slice(0, SUBJECT_BOUND - 1)}…`
}
