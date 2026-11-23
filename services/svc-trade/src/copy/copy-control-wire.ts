/**
 * Wire enums for copy control acks. Each door's disposition is a subset of the
 * exported constants, so a new value cannot leave the service unpinned.
 */
import {
  COPY_PAUSE_DISPOSITIONS,
  copyPauseOutput,
  COPY_STOP_DISPOSITIONS,
  copyStopOutput,
  COPY_DETACH_DISPOSITIONS,
  copyDetachOutput,
  COPY_RESUME_DISPOSITIONS,
  copyResumeOutput,
  COPY_FLATTEN_WIRE_DISPOSITIONS,
  copyFlattenOutput,
} from '@intafaced/contracts/trade-call-schemas';
export {
  COPY_PAUSE_DISPOSITIONS,
  COPY_STOP_DISPOSITIONS,
  copyStopOutput,
  COPY_DETACH_DISPOSITIONS,
  COPY_RESUME_DISPOSITIONS,
  COPY_FLATTEN_WIRE_DISPOSITIONS,
};
