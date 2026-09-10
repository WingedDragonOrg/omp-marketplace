import { initThemeSync, theme, getLanguageFromPath } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SymbolPreset } from "@oh-my-pi/pi-coding-agent/modes/theme/symbols";
import { visibleWidth } from "@oh-my-pi/pi-tui";

const w = (v: string) => `${JSON.stringify(v)}/${visibleWidth(v)}`;
for (const preset of ["ascii", "unicode", "nerd"] as SymbolPreset[]) {
  initThemeSync(preset);
  console.log(`=== ${preset} ===`);
  console.log("lang ts:", w(theme.getLangIconStyled(getLanguageFromPath("src/review-target.ts"))));
  console.log("lang md:", w(theme.getLangIconStyled(getLanguageFromPath("docs/notes.md"))));
  console.log("lang unknown .xyz:", w(theme.getLangIconStyled(getLanguageFromPath("data/file.xyz"))));
  console.log("icon.git:", w(theme.styledSymbol("icon.git", "muted")));
  console.log("icon.session:", w(theme.styledSymbol("icon.session", "muted")));
}
