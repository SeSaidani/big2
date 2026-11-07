# The deal model

How much is a dealt hand worth? This is the model behind the planned "wins above expectation" statistics. It
answers two questions from the hands dealt at a table, before anyone plays a card:

- **Who is likely to win?** A probability for each seat; they add up to 1.
- **How many points is each seat's deal worth?** An expected score for each seat; they add up to 0.

It is fitted offline by `tools/fit-deal-model.js` and saved as `src/stats/deal-model-4.json` and
`src/stats/deal-model-3.json`. `predictDeal` in `src/stats/deal-model.js` applies it.

## What it is, exactly

- **The reference player is the Medium AI.** Every seat of every simulated game is played by Medium, from random
  deals, to the end. The model therefore says how _Medium-style play_ fares from a dealt hand. It does not say how
  any person plays. "Above expectation" later means "better than Medium-style play would have done from those
  cards", which is a useful yardstick but not a measure of absolute skill. People at the table are not Medium, so
  the size of that bias is unknown.
- **The strongest feature is borrowed from Medium itself.** `planCost` is the planner's estimate of how many turns
  a hand needs to go out (see `src/ai/heuristic.js`). Because the reference player is that same planner, the
  model's accuracy describes that world. That is intended, but it also means the accuracy figures below should not
  be read as accuracy against human opponents.
- **Medium has no randomness**, so the only chance in a simulated game is the deal.
- **Who wins** is a conditional logit: a softmax over the seats of one table, so a hand is judged against the
  other hands. **Points** use ridge regression on each seat's features relative to the table's average.
- **Nothing in the model looks at the other hands' contents**, only at a seat's own cards and whether it holds the
  3♦ and so opens. The comparison with the other seats happens in the softmax.

## How it was validated

- Games are seeded from their number alone. Models are fitted on games 1 to N and scored on games 10,000,001
  onwards, a disjoint range, so no game and no deal is in both sets.
- Three models are compared on the held-out games by multiclass log-loss: the uniform guess (1/n), a simple model
  (2s, aces, jokers) and the full model. The rule for keeping the richer model was written into the tool before any
  result was seen: it must beat the simple one by at least 0.002 nats per game and three paired standard errors.
- The standard errors are paired over games (the same game scored by both models), so they are not inflated by
  the four seats of a game being related.

## 4 players

Fitted on 100,000 games and scored on 30,000 different ones.

### Who wins: held-out log-loss (nats per game; lower is better)

| model                     | log-loss ± 95%  | Brier ± 95%     |
| ------------------------- | --------------- | --------------- |
| uniform (1/4)             | 1.3863 ± 0.0000 | 0.7500 ± 0.0000 |
| counts (2s, aces, jokers) | 1.1511 ± 0.0071 |                 |
| full (9 features)         | 1.0014 ± 0.0084 | 0.5498 ± 0.0045 |

Paired improvements (the same games scored by both models):

- counts vs uniform: 0.2352 ± 0.0071 nats per game (64.9 standard errors)
- full vs counts: 0.1497 ± 0.0060 nats per game (48.9 standard errors)
- full vs uniform: 0.3849 ± 0.0084 nats per game (89.8 standard errors)

Rule fixed in advance: ship the full model only if it beats counts by at least 0.002 nats and 3 standard errors. **Shipped: full.**

### Weights of the shipped model (per standard deviation of the feature; ± 1.96 standard errors)

| feature   | weight           |
| --------- | ---------------- |
| twos      | 0.2301 ± 0.0077  |
| aces      | 0.0413 ± 0.0076  |
| kings     | -0.0102 ± 0.0077 |
| jokers    | 0.1283 ± 0.0111  |
| pairs     | -0.0352 ± 0.0090 |
| triples   | 0.0241 ± 0.0095  |
| lowCards  | 0.0209 ± 0.0087  |
| planCost  | -1.2245 ± 0.0167 |
| holdsLead | 0.0389 ± 0.0075  |

### Calibration of the shipped model on held-out games

Seats sorted by predicted chance and cut into eight equal groups:

| predicted | observed | ± 1.96 se | seats |
| --------- | -------- | --------- | ----- |
| 0.0129    | 0.0173   | 0.0021    | 15000 |
| 0.0467    | 0.0480   | 0.0034    | 15000 |
| 0.0921    | 0.0931   | 0.0047    | 15000 |
| 0.1491    | 0.1463   | 0.0057    | 15000 |
| 0.2229    | 0.2187   | 0.0066    | 15000 |
| 0.3209    | 0.3125   | 0.0074    | 15000 |
| 0.4588    | 0.4631   | 0.0080    | 15000 |
| 0.6966    | 0.7009   | 0.0073    | 15000 |

### The seat that opens (holds the 3 of diamonds)

It won 23.4% of 30,000 held-out games, against 25.0% if the seat did not matter (± 0.5 points, 95%).

### Points

Expected points from the shipped features, relative to the table, explain R² = 0.2474 of the variation in a seat's points on held-out games (the baseline of 0 for everyone scores R² = 0; the typical size of a seat's result is 22.3 points). The rest comes from the other hands and the course of play.

## 3 players

Fitted on 60,000 games and scored on 20,000 different ones.

### Who wins: held-out log-loss (nats per game; lower is better)

| model                     | log-loss ± 95%  | Brier ± 95%     |
| ------------------------- | --------------- | --------------- |
| uniform (1/3)             | 1.0986 ± 0.0000 | 0.6667 ± 0.0000 |
| counts (2s, aces, jokers) | 0.9053 ± 0.0078 |                 |
| full (9 features)         | 0.8150 ± 0.0092 | 0.4799 ± 0.0058 |

Paired improvements (the same games scored by both models):

- counts vs uniform: 0.1933 ± 0.0078 nats per game (48.6 standard errors)
- full vs counts: 0.0903 ± 0.0060 nats per game (29.6 standard errors)
- full vs uniform: 0.2836 ± 0.0092 nats per game (60.7 standard errors)

Rule fixed in advance: ship the full model only if it beats counts by at least 0.002 nats and 3 standard errors. **Shipped: full.**

### Weights of the shipped model (per standard deviation of the feature; ± 1.96 standard errors)

| feature   | weight           |
| --------- | ---------------- |
| twos      | 0.2908 ± 0.0102  |
| aces      | 0.0173 ± 0.0100  |
| kings     | 0.0037 ± 0.0099  |
| jokers    | 0.2131 ± 0.0161  |
| pairs     | 0.0879 ± 0.0132  |
| triples   | 0.1015 ± 0.0147  |
| lowCards  | 0.0717 ± 0.0113  |
| planCost  | -0.9433 ± 0.0204 |
| holdsLead | -0.0042 ± 0.0105 |

### Calibration of the shipped model on held-out games

Seats sorted by predicted chance and cut into eight equal groups:

| predicted | observed | ± 1.96 se | seats |
| --------- | -------- | --------- | ----- |
| 0.0321    | 0.0385   | 0.0044    | 7500  |
| 0.0886    | 0.0919   | 0.0065    | 7500  |
| 0.1530    | 0.1540   | 0.0082    | 7500  |
| 0.2309    | 0.2331   | 0.0096    | 7500  |
| 0.3248    | 0.3239   | 0.0106    | 7500  |
| 0.4430    | 0.4312   | 0.0112    | 7500  |
| 0.5923    | 0.5892   | 0.0111    | 7500  |
| 0.8020    | 0.8049   | 0.0090    | 7500  |

### The seat that opens (holds the 3 of diamonds)

It won 33.3% of 20,000 held-out games, against 33.3% if the seat did not matter (± 0.7 points, 95%).

### Points

Expected points from the shipped features, relative to the table, explain R² = 0.2874 of the variation in a seat's points on held-out games (the baseline of 0 for everyone scores R² = 0; the typical size of a seat's result is 20.3 points). The rest comes from the other hands and the course of play.

## What these results say

- **Hand quality, as the planner sees it, is by far the strongest predictor.** At both table sizes `planCost`
  carries most of the weight (negative: a cheaper hand wins more). Real 2s and jokers add value of their own.
  Aces and kings add little beyond what the planner already counts.
- **The model is well calibrated, with one consistent flaw.** Observed win rates track the predictions closely in
  both tables. The weakest group of seats is underestimated at both sizes: 4 players predicted 1.3%, observed 1.7%;
  3 players predicted 3.2%, observed 3.9% (three or more standard errors in each case). Hopeless hands win a little
  more often than the model says. No other group of the sixteen differs by more than about two standard errors.
- **The opener at 4 players wins less than a quarter of the games (23.4%, ± 0.5).** The model still gives the
  opener a small _positive_ weight once hand quality is accounted for, so the seat is not disadvantaged by
  position. Its hands are simply weaker on average (a higher planner cost and fewer 2s than the other seats). Holding the 3♦ means holding the
  lowest card, which must be played to open.
- **The opener at 3 players wins 33.3% (± 0.7), which is the even share.** There is no sign that position matters
  there, so no adjustment to the 3-player scoring is suggested by this data.
- **An earlier impression was wrong.** A first peek at 150 games suggested the 3-player opener won about 43%. At
  that size the error was around four points, and the 20,000 held-out games show it was noise.
- **A deal explains about a quarter to a third of a seat's points** (R² of 0.25 at 4 players and 0.29 at 3). The
  rest comes from the other hands and from how the game is played.

## What was not checked

- How well any of this describes human play, or play against the Hard AI.
- Sensitivity to the ridge penalty (fixed at 1; with tens of thousands of games its effect is negligible, but that
  was not measured).
- Features beyond these nine. The planner feature is a single number; nothing richer (such as which five-card hands
  a hand can make) was tried, because the simple-to-full comparison already showed a large gain and the aim here
  was a defensible baseline, not the best possible model.
- The calibration standard errors treat the seats as independent, though the seats of one game are related. That
  makes them slightly conservative.

## Keeping the saved models honest

The saved models are data files. `test/deal-model-files.test.js` fails if the feature code and a model file
disagree: the column names must match, five stored reference deals must reproduce their stored predictions
exactly, and fresh games, outside both seed ranges, must still be predicted about as well as on the held-out ones.
If the features or the way a model is applied change on purpose, refit and commit the new files.

## Reproducing it

```
node tools/fit-deal-model.js --players 4 --train 100000 --test 30000 --report report4.md
node tools/fit-deal-model.js --players 3 --train 60000 --test 20000 --report report3.md
```

On a 22-core machine the simulation takes about two and a half minutes for 4 players and four minutes for 3.
`--save-data FILE` keeps the simulated games, and `--load-data FILE` refits from them in seconds.
