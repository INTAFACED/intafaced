/**
 * Volt's sheets, in the kit's order: role tokens, self-hosted faces, components, access rules (after lit.css),
 * templates, then Volt's shell (volt.css). Loaded once by the app entry (main.tsx) and by harness entries that render
 * kit-styled rooms. The roles apply under data-look="lit", which index.html puts on the root; the component and
 * template rules match only the kit's own classes (.lit-*, .lt-*).
 */
import '@intafaced/ui/lit/lit.css';
import '@intafaced/ui/lit/fonts.css';
import '@intafaced/ui/a11y/a11y.css';
import '@intafaced/ui/lit/templates.css';
import './volt.css';
