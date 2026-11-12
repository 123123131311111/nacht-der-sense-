#!/usr/bin/env python3
"""
Генератор хоррор-музыки для меню (бесшовный луп, 72 с).
Запуск:  python3 make_menu_music.py   ->  ../menu-horror.mp3  (нужны numpy и ffmpeg)

Всё строится на частотах, кратных 1/72 Гц, и циклической свёртке реверберации,
поэтому конец трека стыкуется с началом без щелчка.
"""
import subprocess, os
import numpy as np

SR = 44100
L = 72.0
N = int(SR * L)
t = (np.arange(N, dtype=np.float64) / SR)
rng = np.random.default_rng(666)
TAU = 2 * np.pi


def per(f):                      # частота, целое число периодов за луп
    return round(f * L) / L


def lfo(periods, phase=0.0):     # медленный периодический LFO 0..1
    return 0.5 + 0.5 * np.sin(TAU * periods * t / L + phase)


def bump(center, width):         # круговой «горб» вокруг момента center (с)
    d = np.abs(((t - center + L / 2) % L) - L / 2)
    return np.exp(-(d / width) ** 2)


def fft_filter(x, fn):           # фильтр в частотной области (периодичный)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR)
    return np.fft.irfft(X * fn(f), len(x))


def circ_conv(x, ir):
    irp = np.zeros(len(x)); irp[:len(ir)] = ir
    return np.fft.irfft(np.fft.rfft(x) * np.fft.rfft(irp), len(x))


def make_ir(seed, length=5.0, decay=1.35, lp=5000):
    r = np.random.default_rng(seed)
    n = int(SR * length)
    tt = np.arange(n) / SR
    ir = r.standard_normal(n) * np.exp(-tt / decay)
    ir = fft_filter(np.pad(ir, (0, 0)), lambda f: 1 / (1 + (f / lp) ** 4))
    ir[: int(0.02 * SR)] *= np.linspace(0, 1, int(0.02 * SR))
    return ir / np.sqrt(np.sum(ir ** 2))


def saw_stack(f, nmax=28, rolloff=1.2, ph=0.0, mod_periods=2, vib=0.0, vib_p=9):
    """Сэмплированная «пила» с медленно «дышащим» тембром."""
    out = np.zeros(N)
    vph = vib * np.sin(TAU * vib_p * t / L) if vib else 0.0
    for n in range(1, nmax + 1):
        if n * f > 5000:
            break
        am = 0.35 + 0.65 * lfo(mod_periods + (n % 3), n * 0.7 + ph)
        out += am * np.sin(TAU * n * f * t + n * vph + n * ph) / n ** rolloff
    return out


def choir(f, formants=((650, 140), (1080, 190), (2600, 350)), vib=0.0018, vib_p=18, ph=0.0):
    """Диссонантный «хор»: гармоники с формантной огибающей (глухое «а-о»)."""
    out = np.zeros(N)
    vph = (vib * f * 6) * np.sin(TAU * vib_p * t / L + ph)   # лёгкий вибрато-дрейф фазы
    n = 1
    while n * f < 4200:
        fr = n * f
        w = sum(np.exp(-0.5 * ((fr - c) / s) ** 2) * a for (c, s), a in zip(formants, (1.0, 0.7, 0.25)))
        if w > 1e-3:
            out += w * np.sin(TAU * fr * t + n * vph + n * ph * 1.3) / n ** 0.4
        n += 1
    return out


def thump(sig, t0, amp, f0=62.0, f1=34.0, dec=0.11):
    tt = t - t0
    m = (tt >= 0) & (tt < 1.2)
    tau = tt[m]
    ph = TAU * (f1 * tau + (f0 - f1) * dec * (1 - np.exp(-tau / dec)))
    sig[m] += amp * np.sin(ph) * np.exp(-tau / dec) * np.minimum(1, tau / 0.004)
    # цирк. перенос хвоста
    return sig


def bell(f0, t0, amp, decay=7.0, pan=0.5, ratios=(1, 2.76, 5.4, 8.93, 13.34, 18.64), seed=1):
    """Металлический, неприятный, неклассически-негармоничный удар."""
    r = np.random.default_rng(seed)
    L_ = np.zeros(N); R_ = np.zeros(N)
    tt = ((t - t0) % L)                        # круговое время от удара
    for i, ra in enumerate(ratios):
        fr = f0 * ra * (1 + r.uniform(-0.004, 0.004))
        a = amp / (1 + i * 0.9)
        d = decay / (1 + i * 0.9)
        s = a * np.sin(TAU * fr * tt + r.uniform(0, 6)) * np.exp(-tt / d) * np.minimum(1, tt / 0.002)
        s *= (1 + 0.15 * np.sin(TAU * (0.7 + 0.3 * i) * tt))     # биения
        L_ += s * (1 - pan); R_ += s * pan
    return L_, R_


def shriek(t0, dur, f_a, f_b, amp, pan):
    tt = t - t0
    m = (tt >= 0) & (tt < dur)
    x = tt[m] / dur
    f = f_a + (f_b - f_a) * x ** 1.5 + 25 * np.sin(TAU * 6.2 * tt[m])
    ph = TAU * np.cumsum(f) / SR
    env = np.sin(np.pi * x) ** 2
    s = np.zeros(N)
    s[m] = amp * env * (np.sin(ph) + 0.5 * np.sin(2 * ph + 0.4) + 0.3 * np.sin(3.01 * ph))
    return s * (1 - pan), s * pan


def whisper(t0, dur, amp, pan, seed):
    """Шипящий «шёпот»: шум через формантные полосы, слоговая модуляция."""
    r = np.random.default_rng(seed)
    n = np.zeros(N)
    m = (t >= t0) & (t < t0 + dur)
    n[m] = r.standard_normal(m.sum())
    nf = fft_filter(n, lambda f: np.exp(-0.5 * ((f - 1700) / 500) ** 2) + 0.6 * np.exp(-0.5 * ((f - 3600) / 800) ** 2))
    syl = (0.5 + 0.5 * np.sin(TAU * (4.5 + r.uniform(-1, 1)) * (t - t0))) ** 2
    env = np.where(m, np.sin(np.pi * np.clip((t - t0) / dur, 0, 1)) ** 1.5, 0)
    s = amp * nf * syl * env
    return s * (1 - pan), s * pan


# ---------------------------------------------------------------- слои
dry = [np.zeros(N), np.zeros(N)]
wet = [np.zeros(N), np.zeros(N)]

# 1) ГЛУБОКИЙ ДРОН: малая секунда + тритон, медленно «дышит»
for ch, det in enumerate((0.0, 0.18)):
    d = (saw_stack(per(36.71 + det), 24, 1.25, 0.0, 2) * 0.55 +
         saw_stack(per(38.89 - det), 24, 1.25, 1.3, 3) * 0.55 +
         saw_stack(per(51.91 + det), 18, 1.5, 2.1, 2) * 0.28 +        # тритон к D
         np.sin(TAU * per(27.5) * t) * 0.22 + np.sin(TAU * per(18.35 + det) * t) * 0.1)
    dry[ch] += d * 0.5 * (0.45 + 0.55 * lfo(1, ch))

# 2) ХОР: тесный кластер из полутонов, вздымается и опадает
choir_notes = [(73.42, 0.0), (77.78, 1.0), (103.83, 2.0), (110.0, 3.0), (146.83, 4.0), (155.56, 5.0), (207.65, 6.0)]
for ch in range(2):
    c = np.zeros(N)
    for i, (f, p) in enumerate(choir_notes):
        sw = (0.5 - 0.5 * np.cos(TAU * (3 + (i % 2)) * t / L + p * 1.1 + ch * 0.6)) ** 2
        c += choir(per(f * (1 + 0.0009 * (ch * 2 - 1))), vib_p=17 + i, ph=p + ch) * sw * (1.0 if f < 160 else 0.55)
    wet[ch] += c * 0.17
    dry[ch] += c * 0.06

# 3) ВЕТЕР / ДЫХАНИЕ ПУСТОТЫ
for ch in range(2):
    nz = rng.standard_normal(N)
    w = fft_filter(nz, lambda f: np.exp(-0.5 * (np.log(np.maximum(f, 1) / 380) / 0.8) ** 2))
    w *= (0.2 + 0.8 * lfo(5, ch * 1.4) * lfo(3, 2 + ch))
    h = fft_filter(rng.standard_normal(N), lambda f: np.exp(-0.5 * (np.log(np.maximum(f, 1) / 4200) / 0.5) ** 2))
    h *= lfo(7, 1.0 + ch) ** 3 * 0.35
    dry[ch] += w * 0.16 + h * 0.05

# 4) СЕРДЦЕБИЕНИЕ (ускоряется и громче к кульминации)
hb = [np.zeros(N), np.zeros(N)]
beat = 1.6
for k in range(int(L / beat)):
    t0 = k * beat
    a = 0.22 + 0.9 * np.exp(-((((t0 - 55 + L / 2) % L) - L / 2) / 14.0) ** 2)
    for ch in range(2):
        thump(hb[ch], t0, a * 0.8)
        thump(hb[ch], t0 + 0.27, a * 0.5, f0=52, f1=32, dec=0.1)
for ch in range(2):
    # хвосты, ушедшие за конец, переносим в начало (бесшовность)
    dry[ch] += hb[ch] * 0.5
    wet[ch] += hb[ch] * 0.08

# 5) МЕТАЛЛ: удары, нарастание, шорох, визги, шёпоты
events = []
for (t0, f0, a, pan, seed) in [(6.0, 92.5, 0.30, 0.25, 1), (23.0, 138.6, 0.26, 0.75, 2),
                               (38.5, 69.3, 0.32, 0.4, 3), (64.0, 110.0, 0.28, 0.65, 4)]:
    bl, br = bell(f0, t0, a, pan=pan, seed=seed)
    wet[0] += bl; wet[1] += br
    dry[0] += bl * 0.25; dry[1] += br * 0.25

# обратное нарастание перед кульминацией (44..56 с): растущий шум + кластер, уходящий вверх
rise = np.zeros(N)
m = (t >= 42) & (t < 56)
x = (t[m] - 42) / 14
fr = 180 * (1 + 4.5 * x ** 2.2)
ph = TAU * np.cumsum(fr) / SR
rs = np.zeros(N)
rs[m] = (np.sin(ph) + 0.8 * np.sin(ph * 1.0595 + 1) + 0.6 * np.sin(ph * 1.4142 + 2)) * x ** 3
for ch in range(2):
    nz = fft_filter(rng.standard_normal(N), lambda f: 1 / (1 + (f / 2500) ** 2))
    nz[~m] = 0
    wet[ch] += (rs * 0.12 + np.where(m, nz * ((t - 42) / 14) ** 3 * 0.18, 0)) * 0.9
    dry[ch] += rs * 0.03

# КУЛЬМИНАЦИЯ 56 с: глубокий удар + низкий рёв
boom = np.zeros(N)
thump(boom, 56.0, 0.7, f0=70, f1=30, dec=0.6)
boom += np.where(t >= 56, np.sin(TAU * 41 * (t - 56)) * np.exp(-(t - 56) / 2.4) * 0.4, 0)
roar = fft_filter(rng.standard_normal(N), lambda f: np.exp(-0.5 * (np.log(np.maximum(f, 1) / 140) / 0.9) ** 2))
roar = np.where(t >= 56, roar * np.exp(-(t - 56) / 1.8) * np.minimum(1, (t - 56) / 0.01), 0)
for ch in range(2):
    dry[ch] += boom * 1.0 + roar * 0.9
    wet[ch] += boom * 0.3 + roar * 0.6
bl, br = bell(55.0, 56.0, 0.5, decay=9.0, pan=0.5, seed=9)
wet[0] += bl; wet[1] += br

# шорох металла
for (t0, dur, seed) in [(15.0, 3.5, 11), (47.0, 4.0, 12)]:
    m2 = (t >= t0) & (t < t0 + dur)
    x = np.clip((t - t0) / dur, 0, 1)
    g = 1500 - 900 * x
    ph = TAU * np.cumsum(g) / SR
    nz = np.random.default_rng(seed).standard_normal(N)
    sc = np.where(m2, nz * np.sin(ph) * np.sin(ph * 1.37) * np.sin(np.pi * x) ** 2, 0)
    sc = fft_filter(sc, lambda f: 1 / (1 + (f / 7000) ** 2))
    wet[0] += sc * 0.09; wet[1] += sc * 0.07

# визги
for (t0, dur, fa, fb, a, pan) in [(31.0, 5.0, 2300, 3300, 0.045, 0.3), (68.0, 3.5, 3600, 2000, 0.04, 0.7),
                                  (50.0, 5.0, 1500, 4200, 0.03, 0.55)]:
    sl, sr_ = shriek(t0, dur, fa, fb, a, pan)
    wet[0] += sl; wet[1] += sr_

# шёпоты
for (t0, dur, a, pan, seed) in [(10.0, 3.0, 0.5, 0.2, 21), (28.0, 2.5, 0.45, 0.8, 22), (36.5, 3.5, 0.5, 0.35, 23),
                                (60.5, 4.0, 0.45, 0.65, 24), (19.5, 2.0, 0.4, 0.5, 25)]:
    wl, wr = whisper(t0, dur, a, pan, seed)
    wet[0] += wl * 0.35; wet[1] += wr * 0.35

# ---------------------------------------------------------------- реверберация (циклическая)
out = []
for ch in range(2):
    ir = make_ir(100 + ch)
    rv = circ_conv(wet[ch], ir)
    out.append(dry[ch] + rv * 0.95 + wet[ch] * 0.12)

mix = np.stack(out, axis=1)
# лёгкая очистка нижнего «мусора» и мягкое ограничение
mix -= mix.mean(axis=0)
for c in range(2):
    mix[:, c] = fft_filter(mix[:, c], lambda f: 1 / (1 + (30 / np.maximum(f, 1e-3)) ** 4))   # убираем инфранизкие
# динамика: тихо-тревожно, сильное нарастание к 56 с и провал после удара
dyn = 0.42 + 0.9 * bump(54.5, 8.5) + 0.12 * lfo(3, 0.5)
mix *= dyn[:, None]
rms = np.sqrt(np.mean(mix ** 2))
mix *= 10 ** (-17 / 20) / rms          # общая громкость ~ -17 dBFS RMS, динамика сохраняется
mix = np.tanh(mix * 1.15) / np.tanh(1.15)   # мягкий лимитер только для пиков
mix *= 0.93 / np.abs(mix).max()

pcm = (mix * 32767).astype('<i2')
tmp = 'menu_horror_tmp.raw'
pcm.tofile(tmp)
here = os.path.dirname(os.path.abspath(__file__))
dst = os.path.join(here, '..', 'menu-horror.mp3')
subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 's16le', '-ar', str(SR), '-ac', '2', '-i', tmp,
                '-codec:a', 'libmp3lame', '-b:a', '160k', dst], check=True)
os.remove(tmp)
print('OK ->', os.path.normpath(dst))
