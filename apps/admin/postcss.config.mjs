/**
 * Next reads this file for every stylesheet it builds. `@tailwindcss/postcss` only acts on a stylesheet that opts in with
 * a Tailwind import or directive (today only `src/components/crm2/ui-kit.css`); every other file, `globals.css` included,
 * passes through untouched, so the console's hand-written CSS cannot change.
 */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
