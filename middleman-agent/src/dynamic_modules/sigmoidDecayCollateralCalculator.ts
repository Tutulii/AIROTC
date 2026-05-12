export function execute(initialCollateral: number, totalDays: number, currentDay: number): number {
  if (currentDay < 0 || currentDay > totalDays) {
    throw new Error('Current day must be within the range of 0 to totalDays.');
  }

  const midpoint = totalDays / 2;
  const steepness = 0.1; // Determines how steep the curve is

  // Sigmoid function
  const sigmoid = (x: number): number => {
    return 1 / (1 + Math.exp(-steepness * (x - midpoint)));
  };

  const decayFactor = sigmoid(currentDay);
  const remainingCollateral = initialCollateral * decayFactor;

  return remainingCollateral;
}