/** Re-export shared choke-point for jobs module callers. */
export {
  STOP_LOAD_BALANCE_TOLERANCE_KG,
  buildStopLoadProfile,
  classWeightKgFromProfile,
  type StopLoadInput,
  type StopLoadProfile,
  type StopLoadSegment,
} from '../../shared/job-stop-load';
