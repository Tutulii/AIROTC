# Sigmoid Decay Collateral Calculator

This module calculates the remaining collateral size using a Sigmoid Decay Curve over a specified duration, typically 30 days. The Sigmoid function is used to model a smooth transition from the initial collateral amount to a reduced amount over time. The curve is characterized by its midpoint and steepness, which determine how quickly the collateral decreases.

## Formula

The Sigmoid function used is:

\[
S(x) = \frac{1}{1 + e^{-k(x - x_0)}}
\]

- **x**: Current day
- **x_0**: Midpoint of the duration (totalDays / 2)
- **k**: Steepness of the curve (0.1 in this implementation)

The remaining collateral is calculated as:

\[
\text{remainingCollateral} = \text{initialCollateral} \times S(\text{currentDay})
\]

## Usage

- **initialCollateral**: The starting amount of collateral (e.g., 500 SOL).
- **totalDays**: The total duration over which the decay occurs (e.g., 30 days).
- **currentDay**: The current day for which the remaining collateral is calculated.

The function will return the remaining collateral for the given day, providing a smooth decay from the initial value to a reduced value over the specified duration.