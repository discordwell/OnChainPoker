import { alwaysCallPlayerBehavior, alwaysTimeoutPlayerBehavior, honestValidatorBehavior } from "./behaviors.js";
import { createDefaultConfig, runSimulation } from "./sim.js";
import type { Behaviors, PlayerId, SimulationResult, ValidatorId } from "./types.js";

function mapFromEntries<K, V>(entries: Array<[K, V]>): Map<K, V> {
  return new Map(entries);
}

export type Scenario = {
  id: string;
  description: string;
  run: () => SimulationResult;
};

export function getScenarios(): Scenario[] {
  return [
    {
      id: "mid-hand-slash-continues",
      description: "invalid shuffle proof -> validator slashed/jailed, hand continues to completion",
      run: () => {
        const cfg = createDefaultConfig(1);
        cfg.hands = 1;
        cfg.committeeSize = 4;
        cfg.thresholdT = 3;
        cfg.validatorSetSize = 4;
        cfg.coordinatorOnline = false; // model outage; no correctness impact

        const validatorBehaviors = mapFromEntries<ValidatorId, any>([
          [
            "V0" as ValidatorId,
            {
              ...honestValidatorBehavior,
              onShuffle: () => "submit-invalid"
            }
          ]
        ]);
        for (let i = 1; i < cfg.validatorSetSize; i++) validatorBehaviors.set(`V${i}` as ValidatorId, honestValidatorBehavior);

        const playerBehaviors = mapFromEntries<PlayerId, any>([]);
        for (let i = 0; i < 6; i++) playerBehaviors.set(`P${i}` as PlayerId, alwaysCallPlayerBehavior);

        const behaviors: Behaviors = { validator: validatorBehaviors, player: playerBehaviors };
        return runSimulation(cfg, behaviors);
      }
    },
    {
      id: "threshold-failure-abort-refund",
      description: "withheld public shares -> threshold failure -> abort + refunds (SPEC 8.2 Option A)",
      run: () => {
        const cfg = createDefaultConfig(2);
        cfg.hands = 1;
        cfg.validatorSetSize = 3;
        cfg.committeeSize = 3;
        cfg.thresholdT = 2;

        const validatorBehaviors = mapFromEntries<ValidatorId, any>([]);
        validatorBehaviors.set("V0" as ValidatorId, honestValidatorBehavior);
        validatorBehaviors.set("V1" as ValidatorId, {
          ...honestValidatorBehavior,
          onPubShare: () => "withhold"
        });
        validatorBehaviors.set("V2" as ValidatorId, {
          ...honestValidatorBehavior,
          onPubShare: () => "withhold"
        });

        const playerBehaviors = mapFromEntries<PlayerId, any>([]);
        // One raise ensures this is "mid-hand" (beyond blinds), so blinds refund special-case won't apply.
        playerBehaviors.set("P0" as PlayerId, {
          onPreflopAction: ({ toCall }: { toCall: number }) => (toCall === 0 ? { type: "check" } : { type: "call" })
        });
        playerBehaviors.set("P1" as PlayerId, {
          onPreflopAction: ({ toCall, minRaiseTo }: { toCall: number; minRaiseTo: number }) =>
            toCall === 0 ? { type: "check" } : { type: "raiseTo", amount: minRaiseTo }
        });
        playerBehaviors.set("P2" as PlayerId, alwaysCallPlayerBehavior);
        for (let i = 3; i < 6; i++) playerBehaviors.set(`P${i}` as PlayerId, alwaysCallPlayerBehavior);

        const behaviors: Behaviors = { validator: validatorBehaviors, player: playerBehaviors };
        return runSimulation(cfg, behaviors);
      }
    },
    {
      id: "repeated-grief-timeouts-drain-bond",
      description: "player repeatedly times out; bond slashed and eventually ejected",
      run: () => {
        const cfg = createDefaultConfig(3);
        cfg.hands = 3;
        cfg.validatorSetSize = 4;
        cfg.committeeSize = 4;
        cfg.thresholdT = 3;
        cfg.params.playerBondMin = 10;
        cfg.startingBond = 12; // should eject by hand 2 or 3 given playerTimeoutSlash=2

        const validatorBehaviors = mapFromEntries<ValidatorId, any>([]);
        for (let i = 0; i < cfg.validatorSetSize; i++) validatorBehaviors.set(`V${i}` as ValidatorId, honestValidatorBehavior);

        const playerBehaviors = mapFromEntries<PlayerId, any>([]);
        // P1 always withholds (times out)
        playerBehaviors.set("P1" as PlayerId, alwaysTimeoutPlayerBehavior);
        for (let i = 0; i < 6; i++) {
          const id = `P${i}` as PlayerId;
          if (!playerBehaviors.has(id)) playerBehaviors.set(id, alwaysCallPlayerBehavior);
        }

        const behaviors: Behaviors = { validator: validatorBehaviors, player: playerBehaviors };
        return runSimulation(cfg, behaviors);
      }
    },
    {
      id: "committee-rotation-two-hands",
      description: "epoch/committee rotates between hands deterministically; slashed validators are excluded",
      run: () => {
        const cfg = createDefaultConfig(4);
        cfg.hands = 2;
        cfg.rotateCommitteeEveryHand = true;
        cfg.validatorSetSize = 6;
        cfg.committeeSize = 4;
        cfg.thresholdT = 3;
        cfg.committeePlan = [
          ["V0", "V1", "V2", "V3"] as ValidatorId[],
          ["V2", "V3", "V4", "V5"] as ValidatorId[]
        ];

        const validatorBehaviors = mapFromEntries<ValidatorId, any>([]);
        for (let i = 0; i < cfg.validatorSetSize; i++) validatorBehaviors.set(`V${i}` as ValidatorId, honestValidatorBehavior);

        // Slash V0 in hand 1 by forcing an invalid shuffle proof; it should be jailed and not reselected.
        validatorBehaviors.set("V0" as ValidatorId, {
          ...honestValidatorBehavior,
          onShuffle: ({ handId }: { handId: number }) => (handId === 1 ? "submit-invalid" : "submit-valid")
        });

        const playerBehaviors = mapFromEntries<PlayerId, any>([]);
        for (let i = 0; i < 6; i++) playerBehaviors.set(`P${i}` as PlayerId, alwaysCallPlayerBehavior);

        const behaviors: Behaviors = { validator: validatorBehaviors, player: playerBehaviors };
        return runSimulation(cfg, behaviors);
      }
    }
  ];
}

export function getScenarioById(id: string): Scenario | undefined {
  return getScenarios().find((s) => s.id === id);
}
