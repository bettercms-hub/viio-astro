// Hand-written bindings for the prop-driven sections: every copy value reads its CMS field and
// declares it with data-bcms-field so the editor binds it without guessing from rendered text.
import home from "../bcms-content/home.json";
import { bcms, bcmsImage, bcmsRows, bcmsStyleText } from "./bcms-content";

const inline = (s: string) => s.replace(/^\s*<p>([\s\S]*)<\/p>\s*$/, "$1");

export const txt = (path: string, fallback: string) => bcms(home, path, fallback);
export const rich = (path: string, fallback: string) => inline(bcms(home, path, fallback));
export const img = <T,>(path: string, fallback: T) => bcmsImage(home, path, fallback);
export const rows = <T,>(path: string, fallback: T[]) => bcmsRows(home, path, fallback);
export const f = (path: string, kind = "text") => ({
  "data-bcms-field": path,
  "data-bcms-kind": kind,
  "data-bcms-style": "2",
  style: bcmsStyleText(home, path),
});
