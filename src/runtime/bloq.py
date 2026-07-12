# Bloq cooperative scheduler runtime.
# Shipped to the device filesystem (/lib/bloq.py) and imported ONLY when a
# program needs concurrency (more than one hat, or a block that requires the
# scheduler). Single-hat programs generate plain linear code and never import
# this, so beginners get readable, one-to-one-with-blocks MicroPython.
#
# Each stack is a Python generator. The scheduler runs each until its next
# `yield`, so everything between two yields is atomic — no locks needed.
import time


class Scheduler:
    def __init__(self):
        self.tasks = []

    def spawn(self, genfn):
        self.tasks.append(genfn())

    def run(self):
        while self.tasks:
            for t in list(self.tasks):
                try:
                    next(t)
                except StopIteration:
                    self.tasks.remove(t)

    # Cooperative wait: yields instead of blocking so other stacks keep running.
    def sleep_ms(self, ms):
        end = time.ticks_add(time.ticks_ms(), ms)
        while time.ticks_diff(end, time.ticks_ms()) > 0:
            yield

    # Edge-friendly wait: yields until pred() becomes true.
    def wait_until(self, pred):
        while not pred():
            yield


sched = Scheduler()
