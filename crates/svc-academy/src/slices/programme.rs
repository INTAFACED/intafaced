//! The programme slice: the calls the door table gives `Slice::Programme`, each routed to its area in
//! [`crate::programme`]: ambassadors and residencies, tournament seasons and prizes, paper drills.

use crate::door::Ctx;
use crate::programme::{ambassadors, paper, tournaments};
use crate::slices::Answer;

pub fn handle(ctx: &Ctx<'_>) -> Answer {
    match ctx.call.path {
        "paperDrill" | "paperDrillResult" | "paperOpsStatus" => paper::handle(ctx),
        "seasons"
        | "season"
        | "seasonCalendar"
        | "tournaments.policy"
        | "standings"
        | "createSeason"
        | "setSeasonStatus"
        | "freezeSnapshot"
        | "tournamentPrizePlane"
        | "tournamentPrizeIntent"
        | "tournamentPrizeStart"
        | "setStanding"
        | "bulkSetStandings" => tournaments::handle(ctx),
        _ => ambassadors::handle(ctx),
    }
}
