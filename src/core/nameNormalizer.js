export function normalizePythonName(name) {
  return String(name)
    .toLowerCase()
    .replace(/\[.*?\]/g, '')
    .replace(/[-_.]+/g, '-')
    .trim();
}
