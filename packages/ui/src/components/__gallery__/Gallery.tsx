/**
 * Static gallery of the M1 UI kit, for eyeballing and screenshots. Not shipped:
 * it is only mounted by a throwaway Vite entry (see the report). Every figure here
 * is SAMPLE data for layout, labelled as such on the page.
 */
import * as React from 'react';
import { ArrowDownUp, CandlestickChart, Home, Send, Settings, Wallet } from 'lucide-react';
import {
  Accordion,
  AccordionItem,
  AccordionPanel,
  AccordionTrigger,
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  AmountInput,
  Amount,
  Autocomplete,
  AutocompleteContent,
  AutocompleteEmpty,
  AutocompleteGroup,
  AutocompleteGroupLabel,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  Button,
  DataTable,
  EmptyState,
  ChoiceGroup,
  ChangeText,
  Checkbox,
  CoinIcon,
  Collapsible,
  CollapsiblePanel,
  CollapsibleTrigger,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  HeroNumber,
  HideBalancesProvider,
  Menu,
  MenuContent,
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  Money,
  NavigationMenu,
  NavigationMenuCard,
  NavigationMenuContent,
  NavigationMenuItem,
  NavigationMenuLink,
  NavigationMenuList,
  NavigationMenuTrigger,
  Pct,
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
  Price,
  SegmentedControl,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Sparkline,
  StateBlock,
  StatusTag,
  Switch,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  ToastProvider,
  ToggleGroup,
  ToggleGroupItem,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
  useToast,
} from '../index.js';
import { KitSections } from './KitSections.js';
import { BrandBar } from '../../brand/brand.js';

// SAMPLE series for layout only.
const UP = ['100', '101.2', '100.6', '102.4', '103.1', '102.2', '104.8', '105.5', '104.9', '106.8', '107.4', '108.9'];
const DOWN = ['100', '99.2', '99.6', '98.1', '98.4', '97.0', '97.6', '96.2', '95.8', '96.4', '94.9', '94.2'];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-line py-8">
      <h2 className="mb-4 text-lg font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Row({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`flex flex-wrap items-center gap-3 ${className}`}>{children}</div>;
}

function MarketCard({ ticker, name, price, pct, series }: { ticker: string; name: string; price: string; pct: string; series: string[] }) {
  return (
    <a
      href="#gallery"
      className="flex h-44 w-46.5 flex-col gap-2 rounded-lg bg-panel p-4 transition-colors duration-(--if-t-fast) ease-if hover:bg-hover"
    >
      <span className="text-md font-medium">
        {ticker} <span className="text-fg-2">{name}</span>
      </span>
      <Sparkline values={series} width={154} height={56} endDot label={`${ticker}, sample`} />
      <Price value={price} className="text-lg font-semibold" />
      <Pct value={pct} arrow className="text-sm" />
    </a>
  );
}

function ToastDemo() {
  const toast = useToast();
  return (
    <Button
      variant="secondary"
      size={32}
      onClick={() => toast.add({ title: 'Bought 0.01 BTC at 83,281.8 USDT', description: 'Sample message' })}
    >
      Show toast
    </Button>
  );
}

const searchItems = [
  { value: 'Coins', items: ['BTC Bitcoin', 'ETH Ethereum'] },
  { value: 'Markets', items: ['BTC/USDT', 'ETH/USDT'] },
];

export function Gallery() {
  // `?only=<part>` shows one kit part and hides the older sections (screenshots, focused review).
  const onlyKit = typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('only');
  const [hidden, setHidden] = React.useState(false);
  const [redUp, setRedUp] = React.useState(false);
  const [mode, setMode] = React.useState('simple');
  const [side, setSide] = React.useState('buy');
  const [range, setRange] = React.useState('30D');
  const [chip, setChip] = React.useState('all');
  const [price, setPrice] = React.useState('83281.8');
  const [amount, setAmount] = React.useState('0.0042');
  const [hero, setHero] = React.useState('250');
  const [tab, setTab] = React.useState('trades');
  const [asset, setAsset] = React.useState<string | null>('all');

  return (
    <TooltipProvider>
      <ToastProvider>
        <div className="if-app min-h-screen" data-up-color={redUp ? 'red' : undefined} id="gallery">
          {/* Top bar mock: UI-SPEC 3.1. Desktop only: there is no phone navigation yet, so below md the mock shows just the name and the account menu rather than overflowing. */}
          <header className="sticky top-0 z-40 flex h-12 items-center gap-8 border-b border-line bg-bg px-4 md:px-6">
            <BrandBar />
            <NavigationMenu className="hidden md:flex">
              <NavigationMenuList>
                <NavigationMenuItem>
                  <NavigationMenuLink
                    render={<a href="#home" />}
                    className="relative inline-flex h-12 items-center text-base font-medium text-fg after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-lime"
                  >
                    Home
                  </NavigationMenuLink>
                </NavigationMenuItem>
                <NavigationMenuItem>
                  <NavigationMenuTrigger>Money</NavigationMenuTrigger>
                  <NavigationMenuContent>
                    <NavigationMenuCard
                      href="#portfolio"
                      icon={<Wallet size={20} strokeWidth={1.5} />}
                      title="Portfolio"
                      description="Your assets and their value"
                    />
                    <NavigationMenuCard
                      href="#activity"
                      icon={<ArrowDownUp size={20} strokeWidth={1.5} />}
                      title="Activity"
                      description="Trades, orders and withdrawals"
                    />
                  </NavigationMenuContent>
                </NavigationMenuItem>
                <NavigationMenuItem>
                  <NavigationMenuTrigger>Trade</NavigationMenuTrigger>
                  <NavigationMenuContent>
                    <NavigationMenuCard
                      href="#markets"
                      icon={<CandlestickChart size={20} strokeWidth={1.5} />}
                      title="Markets"
                      description="Prices for every market"
                    />
                    <NavigationMenuCard
                      href="#convert"
                      icon={<ArrowDownUp size={20} strokeWidth={1.5} />}
                      title="Convert"
                      description="Swap one asset for another"
                    />
                  </NavigationMenuContent>
                </NavigationMenuItem>
                <NavigationMenuItem>
                  <NavigationMenuTrigger>Pay</NavigationMenuTrigger>
                  <NavigationMenuContent>
                    <NavigationMenuCard
                      href="#send"
                      icon={<Send size={20} strokeWidth={1.5} />}
                      title="Send"
                      description="Send money to someone on INTAFACED"
                    />
                  </NavigationMenuContent>
                </NavigationMenuItem>
                <NavigationMenuItem>
                  <NavigationMenuTrigger>More</NavigationMenuTrigger>
                  <NavigationMenuContent>
                    <NavigationMenuCard
                      href="#settings"
                      icon={<Settings size={20} strokeWidth={1.5} />}
                      title="Settings"
                      description="Display, language and notifications"
                    />
                  </NavigationMenuContent>
                </NavigationMenuItem>
              </NavigationMenuList>
            </NavigationMenu>
            <div className="ml-auto flex items-center gap-3">
              <div className="hidden md:block">
                <Autocomplete items={searchItems}>
                  <AutocompleteInput placeholder="Search markets" hint="⌘K" aria-label="Search markets" />
                  <AutocompleteContent>
                    <AutocompleteEmpty>No results</AutocompleteEmpty>
                    <AutocompleteList>
                      {(group: { value: string; items: string[] }) => (
                        <AutocompleteGroup key={group.value} items={group.items}>
                          <AutocompleteGroupLabel>{group.value}</AutocompleteGroupLabel>
                          {group.items.map((item) => (
                            <AutocompleteItem key={item} value={item}>
                              {item}
                            </AutocompleteItem>
                          ))}
                        </AutocompleteGroup>
                      )}
                    </AutocompleteList>
                  </AutocompleteContent>
                </Autocomplete>
              </div>
              <div className="hidden md:block">
                <SegmentedControl
                  aria-label="Layout mode"
                  value={mode}
                  onValueChange={setMode}
                  items={[
                    { value: 'simple', label: 'Simple' },
                    { value: 'pro', label: 'Pro' },
                  ]}
                />
              </div>
              <Menu>
                <MenuTrigger render={<Button variant="secondary" size={32} />}>Account</MenuTrigger>
                <MenuContent>
                  <MenuGroup>
                    <MenuLabel>Signed in</MenuLabel>
                    <MenuItem>Account</MenuItem>
                    <MenuItem>Security</MenuItem>
                  </MenuGroup>
                  <MenuSeparator />
                  <MenuItem>Sign out</MenuItem>
                </MenuContent>
              </Menu>
            </div>
          </header>

          <main className="mx-auto w-full max-w-306 px-0 py-8">
            <p className="mb-6 text-sm text-fg-2">
              UI kit gallery, milestone M1. All numbers are sample layout data, not real balances or prices.
            </p>
            <Row className="mb-2">
              <label className="flex items-center gap-2 text-sm text-fg-2">
                <Switch checked={hidden} onCheckedChange={setHidden} aria-label="Hide balances" /> Hide balances
              </label>
              <label className="flex items-center gap-2 text-sm text-fg-2">
                <Switch checked={redUp} onCheckedChange={setRedUp} aria-label="Red for up" /> Red for up
              </label>
              <ToastDemo />
            </Row>

            <HideBalancesProvider hidden={hidden}>
              <KitSections />
              {onlyKit === null ? (
                <>
                  <Section title="Home hero (HeroNumber, ChangeText, action pills, market cards)">
                    <div className="flex flex-col gap-2">
                      <span className="text-sm text-fg-2">Est. total value</span>
                      <HeroNumber value="3489.16" decimals={2} prefix="$" unit="USD" />
                      <ChangeText value="+$134.46 (+4.02%)" suffix="Today" className="text-base" />
                    </div>
                    <Row className="mt-6 gap-2">
                      <Button variant="primary">Buy</Button>
                      <Button variant="secondary">Sell</Button>
                      <Button variant="secondary">Convert</Button>
                      <Button variant="secondary">Send</Button>
                      <Button variant="secondary">Receive</Button>
                    </Row>
                    <div className="mt-6 w-full max-w-[792px] rounded-lg bg-panel py-2">
                      {[
                        ['Cash', '$1,305.76', '$'],
                        ['Crypto', '$2,183.40', '₿'],
                      ].map(([name, value, glyph]) => (
                        <div key={name} className="flex h-16 items-center gap-3 px-4">
                          <span className="inline-flex size-8 items-center justify-center rounded-pill bg-raised text-md">{glyph}</span>
                          <span className="text-md font-medium">{name}</span>
                          <Money value={value} className="ml-auto text-md" />
                        </div>
                      ))}
                    </div>
                    <div className="mt-6 flex flex-wrap gap-4">
                      <MarketCard ticker="BTC" name="Bitcoin" price="$83,281.80" pct="+1.24%" series={UP} />
                      <MarketCard ticker="ETH" name="Ethereum" price="$2,494.09" pct="−2.34%" series={DOWN} />
                      <MarketCard ticker="USDC" name="USD Coin" price="$1.0000" pct="0.00%" series={['1', '1', '1', '1', '1']} />
                      <MarketCard ticker="IFC" name="Intacoin" price="—" pct="" series={[]} />
                    </div>
                    <Row className="mt-6">
                      <Money value="1234.50" />
                      <Money value={null} />
                      <Amount value="0.0420 BTC" />
                      <Price value="83,281.80" />
                      <Pct value="+1.24%" arrow />
                      <Pct value="−0.28%" arrow />
                      <Pct value="0.00%" />
                      <Pct value={null} />
                    </Row>
                  </Section>
                </>
              ) : null}
            </HideBalancesProvider>

            <Section title="Business page, fields and tables (TEST DATA)">
              <div className="flex flex-col gap-4 rounded-md bg-panel p-6">
                <Button>New payment</Button>
                <ChoiceGroup
                  items={['all', 'captured']}
                  labels={{ all: 'All', captured: 'Captured' }}
                  value="all"
                  onChange={() => undefined}
                  label="Test payment status"
                />
                <DataTable label="Test payments" headers={['Reference', 'Amount', 'Status']}>
                  <tr>
                    <td>TEST-001</td>
                    <td>
                      <Amount value="10.000001" sensitive={false} /> USDT
                    </td>
                    <td>
                      <StatusTag status="filled" label="Captured" />
                    </td>
                  </tr>
                </DataTable>
                <EmptyState title="No test refunds" reason="Refunds appear after a payment is refunded." />
              </div>
            </Section>
            <Section title="Buttons">
              {(['primary', 'secondary', 'ghost', 'buy', 'sell'] as const).map((v) => (
                <Row key={v} className="mb-3">
                  <span className="w-20 text-sm text-fg-2">{v}</span>
                  {([28, 32, 40, 48, 56] as const).map((s) => (
                    <Button key={s} variant={v} size={s}>
                      {v === 'buy' ? 'Buy BTC' : v === 'sell' ? 'Sell BTC' : `Button ${s}`}
                    </Button>
                  ))}
                  <Button variant={v} size={40} disabled>
                    Disabled
                  </Button>
                  <Button variant={v} size={40} loading>
                    Loading
                  </Button>
                </Row>
              ))}
              <Row>
                <span className="w-20 text-sm text-fg-2">desk submit</span>
                <Button variant="buy" shape="rounded" size={40} fullWidth className="max-w-70">
                  Buy BTC
                </Button>
                <Button variant="sell" shape="rounded" size={40} fullWidth className="max-w-70">
                  Sell BTC
                </Button>
              </Row>
            </Section>

            <Section title="Tabs, toggle groups, segmented controls">
              <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
                <TabsList divider>
                  <TabsTab value="trades">Trades</TabsTab>
                  <TabsTab value="orders">Orders</TabsTab>
                  <TabsTab value="withdrawals">Withdrawals</TabsTab>
                </TabsList>
                <TabsPanel value="trades" className="py-4 text-sm text-fg-2">
                  Trades panel
                </TabsPanel>
                <TabsPanel value="orders" className="py-4 text-sm text-fg-2">
                  Orders panel
                </TabsPanel>
                <TabsPanel value="withdrawals" className="py-4 text-sm text-fg-2">
                  Withdrawals panel
                </TabsPanel>
              </Tabs>
              <Row className="mt-4">
                <Tabs defaultValue="a">
                  <TabsList tone="lime">
                    <TabsTab value="a">Home</TabsTab>
                    <TabsTab value="b">Money</TabsTab>
                    <TabsTab value="c">Trade</TabsTab>
                  </TabsList>
                </Tabs>
              </Row>
              <Row className="mt-4">
                <ToggleGroup aria-label="Category" variant="chip" value={chip} onValueChange={setChip}>
                  {['all', 'hot', 'new', 'gainers'].map((c) => (
                    <ToggleGroupItem key={c} value={c}>
                      {c[0]?.toUpperCase() + c.slice(1)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <ToggleGroup aria-label="Range" variant="pill" value={range} onValueChange={setRange}>
                  {['7D', '30D', '90D'].map((c) => (
                    <ToggleGroupItem key={c} value={c}>
                      {c}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </Row>
              <Row className="mt-4">
                <SegmentedControl
                  aria-label="Side"
                  size={40}
                  value={side}
                  onValueChange={setSide}
                  items={[
                    { value: 'buy', label: 'Buy', tone: 'up' },
                    { value: 'sell', label: 'Sell', tone: 'down' },
                  ]}
                  className="w-60"
                />
                <SegmentedControl
                  aria-label="Mode 32"
                  size={32}
                  value={mode}
                  onValueChange={setMode}
                  items={[
                    { value: 'simple', label: 'Simple' },
                    { value: 'pro', label: 'Pro' },
                  ]}
                />
              </Row>
            </Section>

            <Section title="Amount inputs (decimal strings only)">
              <div className="flex flex-wrap items-start gap-8">
                <div className="flex w-80 flex-col gap-3">
                  <AmountInput
                    label="Price"
                    unit="USDT"
                    precision={1}
                    tick="0.1"
                    value={price}
                    onValueChange={setPrice}
                    onMax={undefined}
                    onBbo={() => setPrice('83281.9')}
                  />
                  <AmountInput
                    label="Amount"
                    unit="BTC"
                    precision={8}
                    tick="0.00001"
                    value={amount}
                    onValueChange={setAmount}
                    onMax={() => setAmount('0.5')}
                  />
                  <AmountInput
                    label="Total"
                    unit="USDT"
                    precision={2}
                    value=""
                    onValueChange={() => {}}
                    placeholder="Minimum 5"
                    error="Enter at least 5 USDT"
                  />
                  <AmountInput label="Locked" unit="USDT" precision={2} value="12.5" onValueChange={() => {}} disabled />
                  <p className="if-num text-xs text-fg-2">
                    value = {price} · {amount}
                  </p>
                </div>
                <div className="flex w-120 flex-col rounded-lg bg-panel p-6">
                  <span className="text-center text-sm text-fg-2">You pay (hero size)</span>
                  <AmountInput
                    size="hero"
                    aria-label="You pay"
                    unit="USD"
                    precision={2}
                    value={hero}
                    onValueChange={setHero}
                    placeholder="0"
                  />
                </div>
              </div>
            </Section>

            <Section title="Coin icons, status tags">
              <Row>
                {['BTC', 'ETH', 'USDT', 'USDC', 'IFC', 'XYZ'].map((a) => (
                  <span key={a} className="flex items-center gap-2 text-md font-medium">
                    <CoinIcon asset={a} /> {a}
                  </span>
                ))}
                <CoinIcon asset="BTC" size={20} />
                <CoinIcon asset="BTC" size={28} />
                <CoinIcon asset="BTC" size={40} />
              </Row>
              <Row className="mt-4">
                <StatusTag status="filled" />
                <StatusTag status="working" />
                <StatusTag status="pending" />
                <StatusTag status="cancelled" />
                <StatusTag status="failed" />
              </Row>
            </Section>

            <Section title="Standard states (UI-SPEC 4.3)">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
                <div className="rounded-lg bg-panel p-4">
                  <StateBlock kind="loading" rows={3} rowHeight={40} label="Loading" className="[&>[data-slot=skeleton]]:bg-field" />
                </div>
                <div className="rounded-lg bg-panel">
                  <StateBlock
                    kind="empty"
                    title="No open orders."
                    body="Orders you place will show here."
                    action={{ label: 'Buy crypto', href: '#buy' }}
                  />
                </div>
                <div className="rounded-lg bg-panel">
                  <StateBlock kind="error" thing="your balances" onRetry={() => {}} />
                </div>
                <div className="rounded-lg bg-panel">
                  <StateBlock
                    kind="refused"
                    title="Verify your identity first"
                    body="You need a verified account to do this."
                    code="kyc.tier_required"
                    action={{ label: 'Verify now', href: '#verify' }}
                  />
                </div>
              </div>
              <Row className="mt-4">
                <Skeleton width={240} height={56} />
                <Skeleton width={32} height={32} circle />
                <Skeleton width={154} height={56} />
              </Row>
            </Section>

            <Section title="Overlays and form controls">
              <Row>
                <Select
                  items={{ all: 'All assets', BTC: 'BTC', ETH: 'ETH', USDT: 'USDT' }}
                  value={asset}
                  onValueChange={(v) => setAsset(v as string | null)}
                >
                  <SelectTrigger className="w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {['all', 'BTC', 'ETH', 'USDT'].map((v) => (
                      <SelectItem key={v} value={v}>
                        {v === 'all' ? 'All assets' : v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Popover>
                  <PopoverTrigger render={<Button variant="secondary" size={32} />}>Notifications</PopoverTrigger>
                  <PopoverContent>
                    <PopoverTitle>Notifications</PopoverTitle>
                    <PopoverDescription>You are all caught up.</PopoverDescription>
                  </PopoverContent>
                </Popover>
                <Dialog>
                  <DialogTrigger render={<Button variant="secondary" size={32} />}>Dialog</DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Add funds</DialogTitle>
                      <DialogDescription>Sample dialog content in the standard panel.</DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <Button variant="primary">Continue</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                <AlertDialog>
                  <AlertDialogTrigger render={<Button variant="secondary" size={32} />}>Confirm cancel</AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Cancel this order?</AlertDialogTitle>
                      <AlertDialogDescription>It will leave the book right away.</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogClose render={<Button variant="secondary" size={40} />}>Keep order</AlertDialogClose>
                      <AlertDialogClose render={<Button variant="primary" size={40} />}>Cancel order</AlertDialogClose>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
                <Tooltip>
                  <TooltipTrigger render={<Button variant="ghost" size={32} />}>Hover or focus me</TooltipTrigger>
                  <TooltipContent>Based on what you hold now and today&apos;s prices.</TooltipContent>
                </Tooltip>
                <label className="flex items-center gap-2 text-base">
                  <Checkbox defaultChecked /> Hide cancelled
                </label>
                <label className="flex items-center gap-2 text-base">
                  <Checkbox /> Post only
                </label>
                <Switch defaultChecked aria-label="Demo switch" />
              </Row>
              <div className="mt-6 grid grid-cols-1 gap-8 sm:grid-cols-2">
                <Collapsible className="rounded-lg bg-panel">
                  <CollapsibleTrigger className="flex h-14 w-full items-center justify-between px-4 text-md font-medium">
                    Small balances
                  </CollapsibleTrigger>
                  <CollapsiblePanel>
                    <div className="px-4 pb-4 text-sm text-fg-2">3 assets under $1 (sample)</div>
                  </CollapsiblePanel>
                </Collapsible>
                <Accordion>
                  <AccordionItem value="a">
                    <AccordionTrigger>How do I convert crypto?</AccordionTrigger>
                    <AccordionPanel>Pick two assets, enter an amount and confirm.</AccordionPanel>
                  </AccordionItem>
                  <AccordionItem value="b">
                    <AccordionTrigger>What does it cost?</AccordionTrigger>
                    <AccordionPanel>Sample answer text.</AccordionPanel>
                  </AccordionItem>
                </Accordion>
              </div>
              <p className="mt-6 flex items-center gap-2 text-sm text-fg-2">
                <Home size={16} aria-hidden="true" /> Lucide icons, stroke 1.5 to 1.75.
              </p>
            </Section>
          </main>
        </div>
      </ToastProvider>
    </TooltipProvider>
  );
}
