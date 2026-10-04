/** Join class names, skipping falsy values. */
export function cn(...classes: Array<string | false | null | undefined | 0>): string {
  let out = "";
  for (const c of classes) {
    if (c) out = out ? `${out} ${c}` : c;
  }
  return out;
}
