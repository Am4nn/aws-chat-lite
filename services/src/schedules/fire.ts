/** EventBridge Scheduler's target for room schedules. */
export async function handler(_input: { roomId: string; scheduleId: string; at: string }): Promise<never> {
  throw new Error("not implemented");
}
