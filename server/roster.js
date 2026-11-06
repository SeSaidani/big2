// A season's players: the people an admin has put on its roster. Only they sit at the table. The first four (in the
// order they were added) are seated; any others are reserves who take over a seat when someone leaves, and a person
// who leaves goes to the back of the line. A season that is running or still to come needs at least four players.
//
// Everything here refers to accounts that exist: a player is added by id, and an id with no enabled account behind it
// is refused.

export const MIN_PLAYERS = 4;

export class RosterError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const isOver = (season, now) => season.ends !== null && season.ends <= now;

function seasonOf(db, seasonId) {
  const s = db.prepare('SELECT id, name, starts, ends FROM seasons WHERE id = ?').get(seasonId);
  if (!s) throw new RosterError('No such season.', 404);
  return s;
}

function accountOf(db, userId) {
  if (!Number.isSafeInteger(userId)) throw new RosterError('Pick a player from the list.');
  const u = db.prepare('SELECT id, name, disabled FROM users WHERE id = ?').get(userId);
  if (!u) throw new RosterError('There is no account with that id: only existing accounts can be added.', 404);
  if (u.disabled) throw new RosterError(`${u.name}'s account is disabled, so they cannot be added.`, 409);
  return u;
}

// The players in the order they sit: { userId, name, position }.
export function seasonMembers(db, seasonId) {
  return db
    .prepare(
      `SELECT m.user_id AS userId, u.name AS name, m.position AS position
       FROM season_members m JOIN users u ON u.id = m.user_id
       WHERE m.season_id = ? ORDER BY m.position`,
    )
    .all(seasonId)
    .map((r) => ({ ...r }));
}

export const memberCount = (db, seasonId) =>
  db.prepare('SELECT COUNT(*) AS n FROM season_members WHERE season_id = ?').get(seasonId).n;

// Accounts that could still be added to this season.
export function candidates(db, seasonId) {
  return db
    .prepare(
      `SELECT id, name FROM users
       WHERE disabled = 0 AND id NOT IN (SELECT user_id FROM season_members WHERE season_id = ?)
       ORDER BY name COLLATE NOCASE`,
    )
    .all(seasonId)
    .map((r) => ({ ...r }));
}

// Checks the ids an admin picked when making a season: whole numbers, no repeats, enough of them, all real accounts.
export function validateMemberIds(db, ids, { min = MIN_PLAYERS } = {}) {
  if (!Array.isArray(ids)) throw new RosterError(`Pick at least ${MIN_PLAYERS} players for the season.`);
  const unique = [...new Set(ids)];
  if (unique.length !== ids.length) throw new RosterError('A player is listed twice.');
  for (const id of unique) accountOf(db, id);
  if (unique.length < min) {
    throw new RosterError(`A season needs at least ${MIN_PLAYERS} players: ${unique.length} picked.`);
  }
  return unique;
}

const nextPosition = (db, seasonId) =>
  db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM season_members WHERE season_id = ?').get(seasonId).p;

export function addMember(db, seasonId, userId, now = Date.now()) {
  const season = seasonOf(db, seasonId);
  if (isOver(season, now)) throw new RosterError('That season is over, so its players cannot change.', 409);
  const u = accountOf(db, userId);
  if (db.prepare('SELECT 1 FROM season_members WHERE season_id = ? AND user_id = ?').get(seasonId, userId)) {
    throw new RosterError(`${u.name} is already a player in this season.`, 409);
  }
  db.prepare('INSERT INTO season_members (season_id, user_id, position) VALUES (?, ?, ?)').run(
    seasonId,
    userId,
    nextPosition(db, seasonId),
  );
  return u;
}

// A running or upcoming season cannot drop below four players.
export function removeMember(db, seasonId, userId, now = Date.now()) {
  const season = seasonOf(db, seasonId);
  if (isOver(season, now)) throw new RosterError('That season is over, so its players cannot change.', 409);
  const row = db
    .prepare(
      'SELECT u.name AS name FROM season_members m JOIN users u ON u.id = m.user_id WHERE m.season_id = ? AND m.user_id = ?',
    )
    .get(seasonId, userId);
  if (!row) throw new RosterError('That person is not a player in this season.', 404);
  if (memberCount(db, seasonId) - 1 < MIN_PLAYERS) {
    throw new RosterError(
      `A season needs at least ${MIN_PLAYERS} players, so ${row.name} cannot be removed. Add someone else first.`,
      409,
    );
  }
  db.prepare('DELETE FROM season_members WHERE season_id = ? AND user_id = ?').run(seasonId, userId);
  return row;
}

// Creates a season and its players in one step, so a season is never left half made.
export function setMembers(db, seasonId, ids) {
  const ins = db.prepare('INSERT INTO season_members (season_id, user_id, position) VALUES (?, ?, ?)');
  ids.forEach((id, i) => ins.run(seasonId, id, i + 1));
}

// Who sits down first: the first n players.
export const firstPlayers = (db, seasonId, n) => seasonMembers(db, seasonId).slice(0, n);

// Someone who is not seated yet and is first in line, or null.
export function nextReserve(db, seasonId, seatedIds) {
  return seasonMembers(db, seasonId).find((m) => !seatedIds.includes(m.userId)) ?? null;
}

// A person who gave up their seat goes to the back of the line.
export function sitOut(db, seasonId, userId) {
  db.prepare('UPDATE season_members SET position = ? WHERE season_id = ? AND user_id = ?').run(
    nextPosition(db, seasonId),
    seasonId,
    userId,
  );
}
