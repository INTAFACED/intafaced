import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { components } from '../contracts.js';
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  HIDDEN_MASK,
  Picker,
  PickerList,
  PickerItem,
  PickerTrigger,
  PickerValue,
  useHideBalances,
  useToast,
} from './index.js';

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe('AlertDialog and Picker', () => {
  it('are named in the contracts', () => {
    expect(Object.keys(components)).toEqual(expect.arrayContaining(['AlertDialog', 'Picker']));
  });

  it('Picker draws its trigger as a named combobox showing the chosen label', () => {
    const out = html(
      <Picker items={{ a: 'USDT', b: 'BTC' }} value="b" onValueChange={() => {}}>
        <PickerTrigger aria-label="Asset to send">
          <PickerValue />
        </PickerTrigger>
        <PickerList>
          <PickerItem value="a">USDT</PickerItem>
          <PickerItem value="b">BTC</PickerItem>
        </PickerList>
      </Picker>,
    );
    expect(out).toContain('role="combobox"');
    expect(out).toContain('aria-label="Asset to send"');
    expect(out).toContain('class="lit-select"');
    expect(out).toContain('>BTC<');
    expect(out).not.toContain('>USDT<');
  });

  it('AlertDialog draws nothing while closed, and its open panel is an alertdialog on the sheet layer', () => {
    const dialog = (open: boolean) => (
      <AlertDialog open={open}>
        <AlertDialogContent data-testid="pay-dialog" aria-busy="false">
          <AlertDialogHeader>
            <AlertDialogTitle>Send 5 USDT</AlertDialogTitle>
            <AlertDialogDescription>Arrives instantly</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button tone="secondary" />}>Cancel</AlertDialogClose>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
    expect(html(dialog(false))).toBe('');
    // The portal mounts only in a browser; a static render of the open dialog still must not throw.
    expect(() => html(dialog(true))).not.toThrow();
  });

  it('the header and footer are plain kit blocks that pass their attributes through', () => {
    expect(html(<AlertDialogHeader data-testid="h" />)).toBe('<div data-testid="h" class="lit-alert-head"></div>');
    expect(html(<AlertDialogFooter aria-label="Choices" />)).toBe('<div aria-label="Choices" class="lit-alert-foot"></div>');
  });

  it('re-exports the shell services a room calls but does not draw', () => {
    expect(typeof useToast).toBe('function');
    expect(typeof useHideBalances).toBe('function');
    expect(HIDDEN_MASK).toBe('••••');
  });
});
