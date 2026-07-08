/*
 *  network_stubs.cpp - supplements network_dummy.cpp for DISABLE_NETWORKING
 *  builds. Upstream's dummy file predates several newer network.h entry
 *  points that single-player code paths still call.
 */

#include "cseries.h"
#include "map.h"
#include "player.h"
#include "network.h"
#include "network_games.h"
#include "network_star.h"
#include "progress.h"

#include <string.h>
#include <string>

// --- prediction hooks (marathon2.cpp) -------------------------------------

void NetUpdateUnconfirmedActionFlags() {}

int32 NetGetUnconfirmedActionFlagsCount() { return 0; }

uint32 NetGetUnconfirmedActionFlag(int32) { return 0; }

// --- misc single-player-safe queries ---------------------------------------

bool NetAllowSavingLevel() { return true; }

std::string NetSessionIdentifier() { return std::string(); }

short get_network_compass_state(short) { return _network_compass_all_off; }

long get_player_net_ranking(short, short* kills, short* deaths, bool)
{
	if (kills) *kills = 0;
	if (deaths) *deaths = 0;
	return 0;
}

int32 team_netgame_parameters[NUMBER_OF_TEAM_COLORS][2];

bool NetAllowOverlayMap() { return true; }

int32 NetGetLatency() { return NetworkStats::invalid; }

const NetworkStats& NetGetStats(int)
{
	static NetworkStats stats = { NetworkStats::invalid, NetworkStats::invalid, 0, 0 };
	return stats;
}

void calculate_player_rankings(struct player_ranking_data* rankings)
{
	// mirrors the "no game" behavior: one entry per player, no ranking
	for (int i = 0; i < dynamic_world->player_count; ++i)
	{
		rankings[i].player_index = i;
		rankings[i].ranking = 0;
	}
}

void calculate_ranking_text(char* buffer, long) { buffer[0] = '\0'; }

void calculate_ranking_text_for_post_game(char* buffer, long) { buffer[0] = '\0'; }

// --- progress dialog (implemented in network_dialogs.cpp upstream) ---------
// Used by OGL_Setup's texture preloading; a no-op suffices on the web where
// loads are near-instant from MEMFS.

void open_progress_dialog(size_t, bool) {}
void close_progress_dialog() {}
void set_progress_dialog_message(size_t) {}
void draw_progress_bar(size_t, size_t) {}
void reset_progress_bar() {}
void progress_dialog_event() {}

// --- star protocol tuning knobs (console commands in preferences.cpp) ------

static int32 sDummyMinimumSendPeriod = 3;

void hub_set_minimum_send_period(int32 value) { sDummyMinimumSendPeriod = value; }

int32& hub_get_minimum_send_period() { return sDummyMinimumSendPeriod; }

// --- player start matching (also used when resuming single-player saves) ---
// Copied verbatim from network.cpp, which is not compiled in this
// configuration; the logic is engine-generic and has no network dependency.

void match_starts_with_existing_players(player_start_data* ioStartArray, short* ioStartCount)
{
	bool startAssigned[MAXIMUM_NUMBER_OF_PLAYERS];
	int8 startAssignedToPlayer[MAXIMUM_NUMBER_OF_PLAYERS];
	for (int i = 0; i < MAXIMUM_NUMBER_OF_PLAYERS; i++)
	{
		startAssigned[i] = false;
		startAssignedToPlayer[i] = NONE;
	}

	// First, match starts to players by name.
	for (int s = 0; s < *ioStartCount; s++)
	{
		for (int p = 0; p < dynamic_world->player_count; p++)
		{
			if (startAssignedToPlayer[p] == NONE)
			{
				if (strcmp(ioStartArray[s].name, get_player_data(p)->name) == 0)
				{
					startAssignedToPlayer[p] = s;
					startAssigned[s] = true;
					break;
				}
			}
		}
	}

	// Match remaining starts to remaining players arbitrarily.
	for (int s = 0; s < *ioStartCount; s++)
	{
		if (!startAssigned[s])
		{
			for (int p = 0; p < dynamic_world->player_count; p++)
			{
				if (startAssignedToPlayer[p] == NONE)
				{
					startAssignedToPlayer[p] = s;
					startAssigned[s] = true;
					break;
				}
			}
		}
	}

	// Create new starts for any players not covered.
	int p = 0;
	while (*ioStartCount < dynamic_world->player_count)
	{
		if (startAssignedToPlayer[p] == NONE)
		{
			player_data* thePlayer = get_player_data(p);
			ioStartArray[*ioStartCount].team = thePlayer->team;
			ioStartArray[*ioStartCount].color = thePlayer->color;
			ioStartArray[*ioStartCount].identifier = NONE;
			strncpy(ioStartArray[*ioStartCount].name, thePlayer->name, MAXIMUM_PLAYER_START_NAME_LENGTH + 1);
			startAssignedToPlayer[p] = *ioStartCount;
			startAssigned[*ioStartCount] = true;
			(*ioStartCount)++;
		}

		p++;
	}

	// Assign remaining starts to players that don't exist yet
	p = dynamic_world->player_count;
	for (int s = 0; s < *ioStartCount; s++)
	{
		if (!startAssigned[s])
		{
			startAssignedToPlayer[p] = s;
			startAssigned[s] = true;
			p++;
		}
	}

	// Reorder starts to match players - this is particularly unclever
	player_start_data theOriginalStarts[MAXIMUM_NUMBER_OF_PLAYERS];
	memcpy(theOriginalStarts, ioStartArray, sizeof(theOriginalStarts));
	for (p = 0; p < *ioStartCount; p++)
	{
		ioStartArray[p] = theOriginalStarts[startAssignedToPlayer[p]];
	}
}
