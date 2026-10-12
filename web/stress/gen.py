import random, sys
rng = random.Random(int(sys.argv[1]))
n_y, n_n = int(sys.argv[2]), int(sys.argv[3])
for _ in range(n_y):
    v10 = rng.randint(0, 1)
    N = rng.choice([1024, 2048, 4096])
    r = rng.randint(8, 32)
    k = rng.random()
    if k < 0.3: pers = None
    elif k < 0.4: pers = b''
    else:
        pers = bytes(rng.randrange(256) for _ in range(rng.choice([1, 4, 10, 16, 64, 80, 255, 400])))
        if rng.random() < 0.3: pers = b'\0' * len(pers)
    h = bytes(rng.randrange(256) for _ in range(80))
    print('yespower', v10, N, r, '-' if pers is None else ('E' if pers == b'' else pers.hex()), h.hex())
for _ in range(n_n):
    h = bytes(rng.randrange(256) for _ in range(80))
    if rng.random() < 0.1: h = bytes([rng.choice([0, 255])]) * 80
    print('neoscrypt', 0, 0, 0, '-', h.hex())
