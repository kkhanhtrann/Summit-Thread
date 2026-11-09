// Format the remaining source time before the next topic refresh boundary
export function formatThreadUpdateCountdown(positionMs: number, intervalMinutes: number): string {
  const intervalSeconds = intervalMinutes * 60;
  const elapsedSeconds = Math.floor(Math.max(0, positionMs) / 1_000);
  const remainingSeconds = intervalSeconds - (elapsedSeconds % intervalSeconds);
  const minutes = String(Math.floor(remainingSeconds / 60)).padStart(2, '0');
  const seconds = String(remainingSeconds % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}
