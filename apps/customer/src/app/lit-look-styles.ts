/**
 * The Lit glass look's sheets, in the kit's order: role tokens, self-hosted faces, components, access rules (after
 * lit.css), templates. Loaded once by the app entry (main.tsx) and by harness entries that render kit-styled rooms.
 * The look's own values apply only under data-look="lit"; with it off the roles resolve to today's skin, and the
 * component and template rules match only the kit's own classes (.lit-*, .lt-*), which today's rooms don't render.
 * Every visitor downloads these sheets (about 9 KB gzipped); a room built on a template needs them with the look off too.
 */
import '@intafaced/ui/lit/lit.css';
import '@intafaced/ui/lit/fonts.css';
import '@intafaced/ui/lit/components.css';
import '@intafaced/ui/a11y/a11y.css';
import '@intafaced/ui/lit/templates.css';
