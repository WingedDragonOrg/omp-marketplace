import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { installNativeOctoTools } from "./native-tools.ts";

export default function octoExtension(pi: ExtensionAPI): void {
  installNativeOctoTools(pi);
}
