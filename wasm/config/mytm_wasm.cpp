/*
 *  mytm_wasm.cpp - single-threaded "Time Manager" for the browser build.
 *
 *  Desktop Aleph One runs each mytm task (hub_tick / spoke_tick, 30 Hz) on
 *  its own SDL thread. The browser build is single-threaded, so tasks run
 *  from mytm_pump(), which the engine calls from the main loop and from
 *  every ASYNCIFY sleep/yield (see wasm_net_idle in net_relay.cpp).
 *  The mutex that serialized tasks against the main thread degenerates to
 *  a no-op.
 */

#ifdef __EMSCRIPTEN__

#include "cseries.h"
#include "mytm.h"

#include <vector>

struct myTMTask {
	uint32 mPeriod = 0;
	bool (*mFunction)(void) = nullptr;
	uint64_t mNextDue = 0;
	bool mKeepRunning = false;
};

static std::vector<myTMTaskPtr> sTasks;

void mytm_initialize() {}

bool take_mytm_mutex() { return true; }
bool release_mytm_mutex() { return true; }

myTMTaskPtr myXTMSetup(int32 time, bool (*func)(void))
{
	myTMTaskPtr task = new myTMTask;
	task->mPeriod = time;
	task->mFunction = func;
	task->mNextDue = machine_tick_count() + time;
	task->mKeepRunning = true;
	sTasks.push_back(task);
	return task;
}

myTMTaskPtr myTMRemove(myTMTaskPtr task)
{
	if (task)
		task->mKeepRunning = false;
	return NULL;
}

void myTMCleanup()
{
	auto it = sTasks.begin();
	while (it != sTasks.end())
	{
		if (!(*it)->mKeepRunning)
		{
			delete *it;
			it = sTasks.erase(it);
		}
		else
			++it;
	}
}

// Run every task that has come due. Catch-up is bounded so a long stall
// (tab hidden, big load) doesn't unleash a burst of hundreds of ticks.
void mytm_pump()
{
	const uint64_t now = machine_tick_count();

	for (auto task : sTasks)
	{
		if (!task->mKeepRunning)
			continue;

		int runs = 0;
		while (task->mKeepRunning && now >= task->mNextDue && runs < 10)
		{
			if (!task->mFunction())
			{
				task->mKeepRunning = false;
				break;
			}
			task->mNextDue += task->mPeriod;
			++runs;
		}

		// If we're hopelessly behind, resynchronize instead of spinning.
		if (task->mKeepRunning && now >= task->mNextDue + 10 * (uint64_t)task->mPeriod)
			task->mNextDue = now + task->mPeriod;
	}
}

#endif // __EMSCRIPTEN__
