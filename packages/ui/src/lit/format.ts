/** lit.css as committed: renderLitCss() through prettier with the settings that apply to the file. */
import { format, resolveConfig } from 'prettier';
import { renderLitCss } from './tokens.js';

export async function formattedLitCss(target: string): Promise<string> {
  const options = (await resolveConfig(target)) ?? {};
  return format(renderLitCss(), { ...options, filepath: target });
}
