/**
 * Whether an out-of-app gateway is configured. A set URL is not a liveness
 * probe, and `accepted` is not an end-device delivered fact.
 */
export interface GatewayHealth<C extends 'email' | 'push'> {
  readonly channel: C;
  readonly configured: boolean;
  readonly probed: false;
  readonly code: string;
  readonly reason: string;
}

export interface ProviderHealth {
  readonly email: GatewayHealth<'email'>;
  readonly push: GatewayHealth<'push'>;
  readonly delivered: { readonly observed: false; readonly code: 'notify.delivered_unobserved'; readonly reason: string };
}

function gate<C extends 'email' | 'push'>(
  channel: C,
  url: string | undefined,
  token: string | undefined,
  urlName: string,
  tokenName: string,
): GatewayHealth<C> {
  const configured = Boolean(url?.trim()) && Boolean(token?.trim());
  if (!configured) {
    return {
      channel,
      configured: false,
      probed: false,
      code: channel === 'email' ? 'notify.email_gateway_unconfigured' : 'notify.push_gateway_unconfigured',
      reason: `${urlName} or ${tokenName} is unset, so this channel has no gateway to call.`,
    };
  }
  return {
    channel,
    configured: true,
    probed: false,
    code: 'notify.provider_probe_unconfigured',
    reason: `${channel} gateway URL is set. No health probe is published, so this is not a liveness verdict.`,
  };
}

export function providerHealth(env: Record<string, string | undefined>): ProviderHealth {
  return {
    email: gate(
      'email',
      env.NOTIFY_EMAIL_GATEWAY_URL,
      env.NOTIFY_EMAIL_GATEWAY_TOKEN,
      'NOTIFY_EMAIL_GATEWAY_URL',
      'NOTIFY_EMAIL_GATEWAY_TOKEN',
    ),
    push: gate('push', env.NOTIFY_PUSH_GATEWAY_URL, env.NOTIFY_PUSH_GATEWAY_TOKEN, 'NOTIFY_PUSH_GATEWAY_URL', 'NOTIFY_PUSH_GATEWAY_TOKEN'),
    delivered: {
      observed: false,
      code: 'notify.delivered_unobserved',
      reason: 'Delivery rows record accepted by the inbox or the gateway. No end-device delivered fact is stored.',
    },
  };
}
