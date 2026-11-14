export function urlKey(value) {
  const url = new URL(value);
  const host = url.host.toLowerCase().replace(/^www\./, "");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  return `${host}${path}`;
}
