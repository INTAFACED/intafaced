import type { BlueprintProfile, CrewRole, DecisionStyle, EnergyRhythm, LearningMode, RiskTemperament } from '@intafaced/contracts';
import { blueprintProfileSchema } from '@intafaced/contracts/blueprint';
import { digest, pick, windowAt } from '../deterministic.js';
import {
  EngineUnavailableError,
  type BlueprintRequest,
  type EngineCapability,
  type EngineHealth,
  type EngineProfileResult,
  type NeuralEngineClient,
} from './neural-engine.js';

/**
 * MockNeuralEngine — the deterministic reference implementation.
 *
 * The real engine is an external deployment (§7.1). This mock exists so that
 * everything *downstream* of it — persistence, crew matching, mentor
 * shortlists, export, erasure — is testable without a network, and testable
 * with exact expected values rather than "some profile came back".
 *
 * The contract it upholds, and the only one worth upholding: **the same session
 * input yields the same profile, always.** That is what makes a crew-matching
 * test able to assert a specific placement, and what makes "re-run onboarding
 * and check you land in the same crew" a meaningful assertion rather than a
 * coin flip.
 *
 * `requestId` is deliberately excluded from the derivation. It identifies the
 * *call*, not the person; including it would make every session produce a new
 * profile and quietly destroy the property above.
 *
 * This is not a simulation of the engine's reasoning and does not pretend to
 * be. It is a stable function from session to profile with the right output
 * shape — which is exactly what a test double should be.
 */

const DECISION_STYLES: readonly DecisionStyle[] = ['analytical', 'intuitive', 'collaborative', 'decisive'];
const RISK_TEMPERAMENTS: readonly RiskTemperament[] = ['guarded', 'measured', 'assertive', 'bold'];
const ENERGY_RHYTHMS: readonly EnergyRhythm[] = ['dawn', 'steady', 'surge', 'nocturnal'];
const LEARNING_MODES: readonly LearningMode[] = ['visual', 'narrative', 'hands_on', 'systematic'];
const CREW_ROLES: readonly CrewRole[] = ['anchor', 'scout', 'builder', 'catalyst'];

const CURRICULUM_PATHS = ['foundations', 'markets', 'builder', 'sovereign'] as const;
const TONE_REGISTERS = ['direct', 'warm', 'socratic', 'terse'] as const;

/** Bumped whenever the derivation changes — a profile is comparable only within a version. */
export const MOCK_ENGINE_VERSION = 'mock-1.0.0';

export interface MockNeuralEngineOptions {
  /**
   * Make every call fail, to exercise the degradation path. A test needs the
   * failure to be a property of the engine, not a monkey-patch, so that what it
   * proves is "the service handles an unavailable engine" and not "the service
   * handles this particular stub throwing".
   */
  readonly failWith?: 'unavailable';
  /** Reported latency. Fixed, so nothing downstream can depend on a real clock. */
  readonly latencyMs?: number;
  readonly version?: string;
  /**
   * Salt the derivation. Two mocks with different salts behave like two
   * different engine builds — useful for asserting that a version bump is
   * visible rather than silent.
   */
  readonly salt?: string;
}

export class MockNeuralEngine implements NeuralEngineClient {
  readonly id = 'neural-engine-mock';
  readonly capabilities: readonly EngineCapability[] = ['profile', 'reprofile'];

  private readonly options: MockNeuralEngineOptions;
  /** Fixed at construction; `health()` must not read the clock either. */
  private readonly startedAt: Date;

  constructor(options: MockNeuralEngineOptions = {}, startedAt: Date = new Date()) {
    this.options = options;
    this.startedAt = startedAt;
  }

  health(): EngineHealth {
    if (this.options.failWith) {
      return { healthy: false, latencyMs: 0, lastUpdate: this.startedAt, reason: 'engine stub is configured to fail' };
    }
    return { healthy: true, latencyMs: this.options.latencyMs ?? 12, lastUpdate: this.startedAt };
  }

  async profile(request: BlueprintRequest): Promise<EngineProfileResult> {
    if (this.options.failWith === 'unavailable') {
      throw new EngineUnavailableError('Neural Engine did not answer');
    }

    const profile = deriveProfile(request, this.options.salt ?? '');

    // Validate our own output against the shared contract. If the mock and the
    // schema ever drift, the tests that depend on this must fail here rather
    // than at an INSERT three layers down.
    const parsed = blueprintProfileSchema.safeParse(profile);
    if (!parsed.success) throw new Error(`mock engine produced an invalid profile: ${parsed.error.message}`);

    return {
      engineVersion: this.options.version ?? MOCK_ENGINE_VERSION,
      profile: parsed.data,
      latencyMs: this.options.latencyMs ?? 12,
    };
  }
}

/**
 * Canonical serialisation of the part of a session the profile depends on.
 *
 * Responses are sorted by key so that the order the guided sequence happened to
 * collect answers in cannot change the profile. Two sessions with the same
 * answers are the same session as far as the engine is concerned.
 */
function canonical(request: BlueprintRequest, salt: string): string[] {
  const responses = [...request.responses]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.value < b.value ? -1 : a.value > b.value ? 1 : 0))
    .map((r) => `${r.key}=${r.value}`);

  const birth = request.birthData ? `${request.birthData.date}|${request.birthData.time ?? ''}|${request.birthData.place ?? ''}` : '';

  return [salt, request.locale, birth, ...responses];
}

/**
 * The derivation. Pure: session in, profile out, no clock and no randomness.
 *
 * Exported because the tests assert stability against it directly — a test that
 * can only observe the profile through a class instance cannot distinguish
 * "stable" from "stable within this process".
 */
export function deriveProfile(request: BlueprintRequest, salt = ''): BlueprintProfile {
  const seed = digest(...canonical(request, salt));

  const decisionStyle = pick(DECISION_STYLES, seed, 0);
  const riskTemperament = pick(RISK_TEMPERAMENTS, seed, 1);
  const energyRhythm = pick(ENERGY_RHYTHMS, seed, 2);
  const learningMode = pick(LEARNING_MODES, seed, 3);
  const crewRole = pick(CREW_ROLES, seed, 4);

  return {
    decisionStyle,
    riskTemperament,
    energyRhythm,
    learningMode,
    crewRole,
    curriculumPath: pick(CURRICULUM_PATHS, seed, 5),
    toneRegister: pick(TONE_REGISTERS, seed, 6),
    guardrails: deriveGuardrails(riskTemperament, decisionStyle, seed),
  };
}

/**
 * Default agent guardrails (§7.1).
 *
 * Derived from temperament rather than picked at random, because these are the
 * numbers svc-trade starts a real person on. They are floors a user can raise,
 * never a cap we enforce for them — but a first session should not hand someone
 * 20x leverage because a hash byte came up high.
 */
function deriveGuardrails(risk: RiskTemperament, decision: DecisionStyle, seed: Buffer): BlueprintProfile['guardrails'] {
  const byRisk: Record<RiskTemperament, { maxLeverage: number; dailyLossPromptPct: number }> = {
    guarded: { maxLeverage: 1, dailyLossPromptPct: 2 },
    measured: { maxLeverage: 2, dailyLossPromptPct: 5 },
    assertive: { maxLeverage: 3, dailyLossPromptPct: 8 },
    bold: { maxLeverage: 5, dailyLossPromptPct: 12 },
  };

  const base = byRisk[risk];

  return {
    maxLeverage: base.maxLeverage,
    dailyLossPromptPct: base.dailyLossPromptPct,
    // A decisive trader is the one most likely to fat-finger a market order, so
    // confirmation stays on for them; everyone else gets it on too unless they
    // are both guarded and deliberate. The default is "confirm".
    confirmBeforeMarketOrder: !(risk === 'guarded' && decision === 'analytical'),
    // Copy-trading is surfaced only to people whose profile suggests they will
    // read what they are copying. It is an opt-in surface, not a default one.
    copyTradingVisible: (risk === 'assertive' || risk === 'bold') && windowAt(seed, 7) % 2 === 0,
  };
}
