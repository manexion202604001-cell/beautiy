/**
 * Time source for messaging decisions (quiet hours, reminder scheduling, automations).
 * Tests may override `clock.now` to exercise time-dependent behaviour deterministically.
 */
export const clock = {
  now: (): Date => new Date(),
  /** Marketing quiet hours (21:00–09:00 local) are applied. Only tests switch this off. */
  quietHours: true,
};
