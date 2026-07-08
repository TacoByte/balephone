/* Stubs for POSIX scheduling functions referenced by openal-soft's helpers
   but absent from Emscripten's single-threaded libc. They are only used to
   raise mixer thread priority, which does not exist on the web. */

#include <errno.h>

struct sched_param;

int pthread_setschedparam(unsigned long thread, int policy,
                          const struct sched_param* param)
{
	(void)thread; (void)policy; (void)param;
	return ENOSYS;
}

int sched_get_priority_max(int policy) { (void)policy; return 0; }
int sched_get_priority_min(int policy) { (void)policy; return 0; }
