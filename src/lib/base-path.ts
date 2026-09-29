/** Prefix for a GitLab project site (`/project-name`). Empty on a user site and in local dev. */
export function publicPath(path: string): string {
  const base = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${base}${suffix}`;
}
