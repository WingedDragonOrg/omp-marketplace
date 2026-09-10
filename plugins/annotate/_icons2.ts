import { initThemeSync } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { SymbolPreset } from "@oh-my-pi/pi-coding-agent/modes/theme/symbols";
import { createHarness } from "./src/test-harness";

const show = (title: string, rows: string[]) => {
  console.log(`\n=== ${title} ===`);
  for (const row of rows) console.log(`|${row}|`);
};

for (const preset of ["ascii", "unicode", "nerd"] as SymbolPreset[]) {
  initThemeSync(preset);
  const h = await createHarness();
  h.view.render(96);
  show(`${preset} sources dock`, [h.frame()[1], ...h.frame().slice(2, 6)]);
  // assistant tab: session rows
  const a = await createHarness();
  a.view.render(96);
  a.press("2");
  show(`${preset} assistant dock`, [a.frame()[1], ...a.frame().slice(2, 5)]);
}
