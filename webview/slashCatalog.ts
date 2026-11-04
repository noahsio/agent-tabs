import { DEFAULT_HIDDEN_COMMANDS } from "../src/settings/protocol";

/**
 * Which OmO commands the «/» menu leaves out (it lists every other one) while the host has not sent its list
 * (`hiddenCommands` in the state, edited in «Инструменты»). Names are get_commands names without the leading «/».
 */
export const HIDDEN_COMMANDS: ReadonlySet<string> = new Set(DEFAULT_HIDDEN_COMMANDS);
