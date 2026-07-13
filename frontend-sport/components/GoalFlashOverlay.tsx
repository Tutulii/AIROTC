"use client";

import { teamCode } from "@/lib/sport-utils";

export type GoalFlash = {
  id: number;
  side: "home" | "away";
  score: string;
  teamName: string;
};

/**
 * Odds-chart goal flash:
 * Bicycle kick with FOOT-ON-BALL contact, then ball into a square goal mouth.
 */
export function GoalFlashOverlay({
  flash,
  home,
  away,
}: {
  flash: GoalFlash;
  home: string;
  away: string;
}) {
  const scorer = flash.side === "home" ? home : away;
  const code = teamCode(scorer);

  return (
    <div
      key={flash.id}
      className="goal-flash-overlay"
      role="status"
      aria-live="polite"
      aria-label={`Goal ${scorer} ${flash.score}`}
    >
      <div className="goal-flash-dim" />
      <div className="goal-flash-turf" aria-hidden />

      <div className="goal-flash-stage">
        {/* Square / rectangular goal face (not a triangle) */}
        <div className="goal-box" aria-hidden>
          <div className="goal-box-net" />
          <div className="goal-box-post goal-box-post-l" />
          <div className="goal-box-post goal-box-post-r" />
          <div className="goal-box-bar" />
          <div className="goal-box-base" />
        </div>

        {/* Ball + player share contact zone at ~48% left, ~42% bottom */}
        <div className="goal-flash-ball" aria-hidden />

        <div className="goal-flash-player" aria-hidden>
          <div className="gfp-hair" />
          <div className="gfp-head" />
          <div className="gfp-arm gfp-arm-l" />
          <div className="gfp-arm gfp-arm-r" />
          <div className="gfp-body">
            <span className="gfp-num">10</span>
          </div>
          <div className="gfp-shorts" />
          <div className="gfp-leg gfp-leg-l">
            <div className="gfp-boot" />
          </div>
          <div className="gfp-leg gfp-leg-r">
            <div className="gfp-boot gfp-boot-strike" />
          </div>
        </div>

        <div className="goal-flash-banner">
          <div className="goal-flash-word">GOAL!</div>
          <div className="goal-flash-detail">
            {code} · {flash.score}
          </div>
        </div>
      </div>
    </div>
  );
}
