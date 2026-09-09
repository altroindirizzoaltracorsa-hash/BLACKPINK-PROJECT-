"""
Replace the proportionally-scaled 2026-08-02 per-track baseline with the
EXACT kworb Aug 2 values, then recompute each track's 2026-08-03 daily_delta
against that corrected baseline.

Background
----------
The earlier recovery (fix-aug-tracks.py) rebuilt the deleted 2026-08-02
per-track rows by proportional scaling from artist-level deltas. That estimate
is inaccurate, so every 2026-08-03 daily_delta (= aug3_streams - aug2_streams)
came out wrong -- e.g. JISOO "FLOWER" showed +261,283 instead of the true
+131,542.

This script fixes it with ground-truth data:
  * 2026-08-02 row : streams + daily_delta set to the exact kworb values.
  * 2026-08-03 row : streams left UNCHANGED (already real Aug 3 data);
                     daily_delta recomputed = aug3_streams - exact_aug2_streams.

Safe by default: prints a full before/after diff and writes NOTHING unless the
environment variable APPLY=1 is set.

Extend by adding more artists to EXACT below (same kworb "Streams"/"Daily"
columns, keyed by the exact track name as stored in artist_tracks).
"""

import os
import sys
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
APPLY = os.environ.get("APPLY") == "1"

AUG2 = "2026-08-02"
AUG3 = "2026-08-03"

# artist_id -> { track_name : (aug2_streams, aug2_daily) }  from kworb, updated
# 2026/08/03 (which is the finalized Aug 2 snapshot). Track names must match
# artist_tracks.name exactly.
EXACT = {
    # JISOO -- sums to 1,356,134,692 total / 698,991 daily (matches artist total)
    "6UZ0ba50XreR4TM8u322gs": {
        "FLOWER":                              (631_066_507, 131_345),
        "earthquake":                          (192_965_542, 154_918),
        "All Eyes On Me":                      (188_386_985,  45_325),
        "EYES CLOSED (with ZAYN)":             (173_104_519, 170_480),
        "Your Love":                           ( 81_689_058,  99_656),
        "Hugs & Kisses":                       ( 45_522_593,  53_236),
        "TEARS":                               ( 33_047_308,  33_412),
        "earthquake - Sam Feldt remix":        (  5_124_207,   4_312),
        "EYES CLOSED (with ZAYN) - 2X":        (  2_003_305,   2_320),
        "EYES CLOSED (with ZAYN) - 0.5X":      (  1_366_704,   1_386),
        "EYES CLOSED (with ZAYN) - BARE":      (  1_273_041,   1_599),
        "EYES CLOSED (with ZAYN) - UNVEILED":  (    584_923,   1_002),
    },
    # JENNIE -- kworb Aug 2, verified to sum to 8,200,235,274 / 8,184,116 before
    # the Black override below (Black switched from kworb to its frozen Spotify value).
    "250b0Wlc5Vk0CoUsaCY84M": {
        "One Of The Girls (with JENNIE, Lily Rose Depp)":                       (2_767_758_502, 1_638_368),
        "like JENNIE":                                                          (  911_742_688,   749_703),
        "SOLO":                                                                 (  792_898_224,   145_170),
        "Mantra":                                                               (  569_233_672,   293_434),
        "Dracula - JENNIE Remix":                                               (  448_502_806, 1_605_936),
        "You & Me":                                                             (  348_983_988,   121_861),
        "ExtraL (feat. Doechii)":                                               (  341_289_583,   203_550),
        "SPOT!":                                                                (  301_673_411,   122_341),
        "Love Hangover (feat. Dominic Fike)":                                   (  240_880_419,   164_894),
        "Handlebars (feat. Dua Lipa)":                                          (  216_002_017,   226_506),
        "Seoul City":                                                           (  201_336_505,   248_702),
        "You & Me (Coachella ver.)":                                            (  115_589_493,    32_809),
        "ZEN":                                                                  (  108_910_817,   106_445),
        "with the IE (way up)":                                                 (  106_282_595,   104_539),
        "Damn Right (feat. Childish Gambino & Kali Uchis)":                     (   99_734_722,    98_496),
        "start a war":                                                          (   79_783_731,    77_258),
        # kworb (71,156,105) is ~4 days stale for this track (= the DB's Jul 29
        # value), so it's the wrong Aug 2 source. The DB has real Aug 1
        # (71,310,393) and real Aug 3 (71,404,579, frozen since); Aug 2 is the
        # midpoint interpolation: 71,310,393 + 94,186/2 = 71,357,486 (+47,093/day).
        "Black (Feat. JENNIE of BLACKPINK)":                                    (   71_357_486,    47_093),
        "Filter":                                                               (   48_981_286,    50_558),
        "One Of The Girls - Sped Up":                                           (   48_201_072,    24_667),
        "Starlight":                                                            (   47_014_870,    62_934),
        "twin":                                                                 (   46_503_998,    39_539),
        "SOLO - Live":                                                          (   42_529_239,    14_540),
        "Intro : JANE with FKJ":                                                (   35_590_475,    31_834),
        "F.T.S.":                                                               (   34_408_519,    34_450),
        "Slow Motion":                                                          (   33_501_560,    15_967),
        "like JENNIE - Extended Remix":                                         (   21_443_023,    72_575),
        "Less Than a Lover":                                                    (   21_336_533, 1_673_837),
        'SOLO - BLACKPINK ARENA TOUR 2018 "SPECIAL FINAL IN KYOCERA DOME OSAKA"': ( 14_143_103,     7_068),
        "One Of The Girls - Slowed":                                            (   14_100_828,    10_205),
        "like JENNIE - Peggy Gou Remix":                                        (   13_442_077,    10_262),
        "Special":                                                              (   12_219_313,     4_901),
        "like JENNIE - EDM Remix":                                              (   10_619_218,    21_525),
        "One Of The Girls - Instrumental":                                      (    7_434_809,     8_268),
        "ExtraL - Just JENNIE":                                                 (    5_808_206,    13_467),
        "Damn Right - Just JENNIE":                                             (    5_482_095,    17_539),
        "One Of The Girls - A Cappella":                                        (    5_099_470,     6_808),
        "Handlebars - Just JENNIE":                                             (    3_464_086,    54_217),
        "Dracula - JENNIE Remix - Boys Noize Disko Version":                    (    2_965_867,    14_895),
        "Love Hangover - Just JENNIE":                                          (    2_907_459,     9_216),
        "like JENNIE - Peggy Gou Remix - EXTENDED MIX":                         (      780_438,       493),
        "Dracula - JENNIE Remix Instrumental":                                  (      498_452,     1_044),
    },
    # ROSÉ -- sums to 5,659,564,253 total / 3,094,004 daily (matches artist total)
    "3eVa5w3URK5duf6eyVDbu9": {
        "APT.":                        (2_570_408_256, 1_368_113),
        "On The Ground":               (  590_309_519,    97_253),
        "Gone":                        (  471_129_663,   101_382),
        "toxic till the end":          (  463_997_789,   340_851),
        "number one girl":             (  354_264_655,   248_560),
        "Messy (From F1® The Movie)":  (  192_298_736,   185_211),
        "On My Mind":                  (  142_779_877,   128_928),
        "drinks or coffee":            (  139_109_161,   100_443),
        "stay a little longer":        (  110_880_164,   101_186),
        # kworb/zonitex are ~5 days stale here (104,764,170); Spotify/DB is ahead.
        # DB has real Aug 1 (104,909,926) and Aug 3 (104,999,022); interpolate Aug 2:
        # 104,909,926 + 89,096/2 = 104,954,474 (+44,548/day). Same method as Black.
        "Without You (Feat. ROSE)":    (  104_954_474,    44_548),
        "3am":                         (   95_073_458,    88_069),
        "two years":                   (   94_032_413,    75_162),
        "gameboy":                     (   91_473_473,    58_444),
        "too bad for us":              (   57_877_150,    42_935),
        "dance all night":             (   56_732_388,    48_629),
        "call it the end":             (   47_432_814,    37_054),
        "not the same":                (   46_395_709,    25_967),
        "Gone - Live":                 (   30_604_858,     5_141),
    },
    # LISA -- sums to 5,403,262,786 total / 2,061,309 daily (matches artist total)
    "5L1lO4eRHmJ7a0Q6csE5cT": {
        "MONEY":                                                                    (1_427_577_890, 189_584),
        "LALISA":                                                                   (  647_712_828, 106_661),
        "Rockstar":                                                                 (  618_800_167, 333_970),
        "Moonlit Floor (Kiss Me)":                                                  (  434_830_361, 150_615),
        "New Woman (feat. ROSALÍA)":                                                (  415_243_371, 130_953),
        "Born Again (feat. Doja Cat & RAYE)":                                       (  382_552_728, 187_659),
        "SG (with Ozuna, Megan Thee Stallion & LISA of BLACKPINK)":                 (  350_570_741,  51_937),
        # kworb ~8.5 days stale (222,152,007); Spotify/DB ahead. Real Aug 1
        # (222,482,934) and Aug 3 (222,569,817) bracket Aug 2 -> midpoint
        # 222,526,376 (+43,442/day). Same method as Black / Without You.
        "Shoong! (feat. LISA of BLACKPINK)":                                        (  222_526_376,  43_442),
        "FXCK UP THE WORLD (feat. Future)":                                         (  111_434_599,  46_813),
        "Priceless (feat. LISA)":                                                   (  104_528_036,  57_272),
        "Dream":                                                                    (   99_428_466, 118_925),
        "Chill":                                                                    (   74_505_917,  45_536),
        "When I'm With You (feat. Tyla)":                                           (   59_664_709,  34_983),
        "Rockstar - Extended":                                                      (   58_188_272,  16_567),
        "Bad Angel (with LISA)":                                                    (   53_710_233, 156_096),
        "FXCK UP THE WORLD (Vixi Solo Version)":                                    (   51_916_962,  39_809),
        "Lifestyle":                                                                (   51_041_050,  36_787),
        "Elastigirl":                                                               (   40_221_013,  34_025),
        "Thunder":                                                                  (   40_179_872,  27_468),
        "Goals":                                                                    (   36_451_164, 201_346),
        "Rapunzel (feat. Megan Thee Stallion)":                                     (   24_652_016,  13_585),
        "BADGRRRL":                                                                 (   20_984_168,  14_336),
        "Rapunzel (Kiki Solo Version)":                                             (   16_201_835,  10_521),
        "Rockstar - Sped Up":                                                       (   12_385_341,   1_446),
        "Moonlit Floor (Kiss Me) - Santa Baby Remix":                              (   11_956_887,     804),
        "Rockstar - Instrumental":                                                  (   11_461_218,   1_515),
        "Rockstar - Slowed Down":                                                   (   10_226_010,   1_330),
        "Moonlit Floor (Kiss Me) - Live Performance Version":                       (    6_199_762,     948),
        "Born Again (feat. Doja Cat & RAYE) - Purple Disco Machine Remix":          (    5_944_313,   3_600),
        "Moonlit Floor (Kiss Me) - Instrumental":                                   (    2_113_135,     166),
        "Born Again (feat. Doja Cat & RAYE) - Purple Disco Machine Extended Mix":   (      427_715,     252),
    },
    # BLACKPINK -- sums to 17,595,602,852 total / 4,359,152 daily (matches artist total)
    "41MozSoPIsD1dJM0CLPjZF": {
        "How You Like That":                                   (1_271_572_786, 232_215),
        "Kill This Love":                                      (1_055_557_779, 205_892),
        "Pink Venom":                                          (1_024_301_914, 238_421),
        "Shut Down":                                           (  901_806_583, 207_863),
        "DDU-DU DDU-DU":                                       (  882_286_869, 185_025),
        "As If It's Your Last":                                (  805_615_338, 221_537),
        "Kiss and Make Up":                                    (  775_751_901, 135_496),
        "Lovesick Girls":                                      (  735_771_720, 162_092),
        "BOOMBAYAH":                                           (  718_957_467, 210_096),
        "Ice Cream (with Selena Gomez)":                       (  671_237_485,  87_907),
        "JUMP":                                                (  664_256_627, 632_266),
        "Pretty Savage":                                       (  591_070_370, 110_459),
        "PLAYING WITH FIRE":                                   (  561_722_971, 133_258),
        "WHISTLE":                                             (  502_247_821, 114_335),
        "Typa Girl":                                           (  481_964_640,  89_395),
        "Forever Young":                                       (  445_261_340, 108_399),
        "Sour Candy (with BLACKPINK)":                         (  424_636_835,  48_233),
        "Don't Know What To Do":                               (  365_646_962,  66_012),
        "Tally":                                               (  342_916_499,  63_177),
        "Love To Hate Me":                                     (  291_842_946,  61_190),
        "STAY":                                                (  286_036_247,  56_710),
        "Crazy Over You":                                      (  280_928_526,  43_200),
        "Hard to Love":                                        (  271_995_944,  49_409),
        "Bet You Wanna (feat. Cardi B)":                       (  222_379_646,  27_545),
        "You Never Know":                                      (  206_418_558,  31_249),
        "Really":                                              (  197_671_241,  34_257),
        "Kick It":                                             (  191_706_149,  32_271),
        "See U Later":                                         (  172_950_382,  32_063),
        "THE GIRLS - BLACKPINK THE GAME OST":                  (  166_326_795,  37_594),
        "The Happiest Girl":                                   (  165_430_738,  32_023),
        "Ready For Love":                                      (  150_999_944,  33_813),
        "Yeah Yeah Yeah":                                      (  147_751_465,  27_132),
        "Hope Not":                                            (  141_560_208,  20_625),
        "BOOMBAYAH - Japanese Version":                        (   99_544_664,  10_271),
        "DDU-DU DDU-DU - Remix":                               (   94_438_588,  14_127),
        "GO":                                                  (   94_795_845, 201_316),
        "DDU-DU DDU-DU - Japanese Version":                    (   81_020_848,   9_488),
        "WHISTLE - Acoustic Ver.":                             (   80_527_366,  12_116),
        "SO HOT - THEBLACKLABEL REMIX ARENA TOUR OSAKA":       (   79_382_456,  10_067),
        "AS IF IT'S YOUR LAST - Japanese Version":             (   56_028_678,  12_169),
        "FOREVER YOUNG - Japanese Version":                    (   46_509_918,   5_778),
        "WHISTLE - Japanese Version":                          (   46_194_547,   2_799),
        "Champion":                                            (   46_995_665,  98_992),
        "PLAYING WITH FIRE - Japanese Version":                (   43_955_313,   3_204),
        "DDU-DU DDU-DU - Live":                                (   42_686_370,   5_462),
        "SEE U LATER - Japanese Version":                      (   39_737_378,   4_890),
        "REALLY - Japanese Version":                           (   38_266_924,   5_121),
        "STAY - Japanese Version":                             (   38_007_181,   3_058),
        "KILL THIS LOVE - JP Ver.":                            (   37_767_747,   1_982),
        "Kiss and Make Up - ARENA TOUR OSAKA":                 (   32_974_546,  11_882),
        "Me and my":                                           (   33_296_228,  67_848),
        "LET IT BE~YOU&I~ONLY LOOK AT ME - ARENA TOUR OSAKA":  (   24_858_827,   3_095),
        "Fxxxboy":                                             (   24_174_354,  47_179),
        "Pretty Savage - JP Ver.":                             (   20_365_179,   1_267),
        "Yuki no Hana/JISOO - LIVE ARENA TOUR OSAKA":          (   15_067_621,   1_985),
        "DDU-DU DDU-DU - Remix -JP Ver.-":                     (   14_138_990,   1_227),
        "Kill This Love - Live":                               (   13_559_550,   2_769),
        "Pretty Savage - Live":                                (   12_671_932,   2_570),
        "Lovesick Girls - JP Ver.":                            (   11_581_039,   1_802),
        "YOU & I + ONLY LOOK AT ME - Live":                    (   11_319_954,   2_233),
        "Crazy Over You - Live":                               (   11_060_452,   1_734),
        "How You Like That - JP Ver.":                         (   10_922_790,   4_445),
        "DDU-DU DDU-DU - Live (2)":                            (   10_810_424,   2_072),
        "How You Like That - Live":                            (   10_600_695,   1_806),
        "Lovesick Girls - Live":                               (   10_233_712,   1_897),
        "Sour Candy - Shygirl & Mura Masa Remix":              (    9_536_542,     967),
        "Love To Hate Me + You Never Know - Live":             (    8_953_006,   1_807),
        "Don't Know What To Do - Live":                        (    8_689_889,   1_530),
        "PLAYING WITH FIRE - Live (2)":                        (    8_687_900,   2_043),
        "DDU-DU DDU-DU - JP Ver./TOKYO DOME":                  (    8_641_570,     557),
        "WHISTLE - Acoustic Ver. Japanese Version":            (    7_866_807,     416),
        "Forever Young - Live":                                (    7_679_615,     943),
        "BOOMBAYAH - Live":                                    (    6_936_382,   1_319),
        "SOLO - Live":                                         (    6_884_988,     728),
        "WHISTLE - Live (2)":                                  (    6_826_241,   1_203),
        "Kill This Love - JP Ver./TOKYO DOME":                 (    6_565_050,     772),
        "As If It's Your Last - Live (2)":                     (    6_520_690,   1_250),
        "BOOMBAYAH - Live (2)":                                (    6_435_966,     943),
        "Forever Young - Live (2)":                            (    5_747_715,   1_137),
        "Last Christmas/Akahana no Tonakai - ARENA TOUR OSAKA":(    5_738_814,   1_011),
        "DDU-DU DDU-DU (Remix Version) - Live":                (    5_634_332,     429),
        "DON'T KNOW WHAT TO DO - JP Ver.":                     (    5_588_973,     871),
        "FOREVER YOUNG - JP Ver./TOKYO DOME":                  (    5_522_126,     646),
        "PLAYING WITH FIRE - Live (SEOUL)":                    (    5_418_068,     769),
        "STAY (Remix Version) - Live":                         (    5_333_673,     446),
        "WHISTLE (Remix Version) - Live":                      (    5_290_175,     625),
        "Really (Reggae Version) - Live":                      (    5_278_823,     436),
        "As If It's Your Last - Live (SEOUL)":                 (    5_204_946,     544),
        "BOOMBAYAH - JP Ver./TOKYO DOME":                      (    4_998_323,     771),
        "STAY - Live":                                         (    4_596_008,     556),
        "WHISTLE - Live (SEOUL)":                              (    4_580_570,     398),
        "Don't Know What To Do - JP Ver./TOKYO DOME":          (    4_545_811,     397),
        "WHISTLE - JP Ver./TOKYO DOME":                        (    4_517_641,     532),
        "STAY - Remix/JP Ver./TOKYO DOME":                     (    4_360_316,     369),
        "You Never Know - JP Ver.":                            (    4_208_949,     529),
        "HOPE NOT - JP Ver.":                                  (    4_151_356,     611),
        "KICK IT - JP Ver.":                                   (    4_145_469,     859),
        "DDU-DU DDU-DU - ARENA TOUR OSAKA":                    (    4_062_382,     335),
        "See U Later - Live":                                  (    3_996_764,     400),
        "AS IF IT'S YOUR LAST - JP Ver./TOKYO DOME":           (    3_961_163,     495),
        "Kiss and Make Up (Remix) [Mixed]":                    (    3_858_944,     197),
        "REALLY - JP Ver./TOKYO DOME":                         (    3_644_769,     344),
        "PLAYING WITH FIRE - JP Ver./TOKYO DOME":              (    3_631_375,     361),
        "Kick It - JP Ver./TOKYO DOME":                        (    3_511_359,     269),
        "SEE U LATER - JP Ver./TOKYO DOME":                    (    3_057_128,     273),
        "BOOMBAYAH - ARENA TOUR OSAKA":                        (    2_994_421,     323),
        "FOREVER YOUNG - ARENA TOUR OSAKA":                    (    2_977_826,     315),
        "WHISTLE - Acoustic Ver. ARENA TOUR OSAKA":            (    2_795_108,     276),
        "STAY - ARENA TOUR OSAKA":                             (    2_735_482,     287),
        "AS IF IT'S YOUR LAST - ARENA TOUR OSAKA":             (    2_543_289,     287),
        "PLAYING WITH FIRE - ARENA TOUR OSAKA":                (    2_387_609,     241),
        "REALLY - ARENA TOUR OSAKA":                           (    2_199_199,     269),
        "SEE U LATER - ARENA TOUR OSAKA":                      (    2_080_823,     256),
    },
}

ARTIST_NAMES = {
    "41MozSoPIsD1dJM0CLPjZF": "BLACKPINK",
    "6UZ0ba50XreR4TM8u322gs": "JISOO",
    "250b0Wlc5Vk0CoUsaCY84M": "JENNIE",
    "3eVa5w3URK5duf6eyVDbu9": "ROSÉ",
    "5L1lO4eRHmJ7a0Q6csE5cT": "LISA",
}


def sb(method, path, **kwargs):
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        **kwargs.pop("headers", {}),
    }
    r = httpx.request(method, f"{SUPABASE_URL}/rest/v1{path}",
                      headers=headers, timeout=30, **kwargs)
    if r.is_error:
        print(f"  ERROR {r.status_code}: {r.text}", file=sys.stderr)
    r.raise_for_status()
    return r.json() if r.content else None


def rows_by_ref(refs, date):
    if not refs:
        return {}
    got = sb("GET", "/track_daily_stats", params={
        "track_ref": f"in.({','.join(refs)})",
        "date": f"eq.{date}",
        "select": "track_ref,streams,daily_delta",
    })
    return {str(r["track_ref"]): r for r in (got or [])}


def process_artist(artist_id, exact):
    name = ARTIST_NAMES.get(artist_id, artist_id)
    print(f"\n=== {name} ({artist_id}) ===")

    tracks = sb("GET", "/artist_tracks", params={
        "artist_id": f"eq.{artist_id}", "select": "id,name",
    }) or []
    name_to_ref = {t["name"]: str(t["id"]) for t in tracks}

    missing = [n for n in exact if n not in name_to_ref]
    if missing:
        print(f"  WARNING: {len(missing)} kworb names not found in artist_tracks:")
        for n in missing:
            print(f"    - {n!r}")

    refs = [name_to_ref[n] for n in exact if n in name_to_ref]
    cur_aug2 = rows_by_ref(refs, AUG2)
    cur_aug3 = rows_by_ref(refs, AUG3)

    aug2_writes, aug3_writes = [], []
    print(f"  {'track':<38} {'aug2 old→new streams':<34} {'aug3 daily old→new'}")
    for tname, (ex_streams, ex_daily) in exact.items():
        ref = name_to_ref.get(tname)
        if not ref:
            continue
        old2 = cur_aug2.get(ref)
        old3 = cur_aug3.get(ref)
        old2s = old2["streams"] if old2 else None
        aug3_streams = old3["streams"] if old3 else None
        old3d = old3["daily_delta"] if old3 else None

        new3d = (aug3_streams - ex_streams) if aug3_streams is not None else None
        # trend = did Aug 3 do more (+) or less (-) daily streams than Aug 2?
        trend = (new3d - ex_daily) if new3d is not None else None

        s_old2 = f"{old2s:,}" if old2s is not None else "—"
        s_new3 = f"{new3d:,}" if new3d is not None else "—(no aug3 row)"
        s_old3 = f"{old3d:,}" if old3d is not None else "—"
        s_trend = f"{trend:+,} vs Aug2" if trend is not None else "—"
        print(f"  {tname[:37]:<38} {s_old2:>15} → {ex_streams:>14,}   "
              f"aug3 daily {s_old3:>9} → {s_new3:>9}   trend {s_trend}")

        aug2_writes.append({
            "track_ref": int(ref), "date": AUG2,
            "streams": ex_streams, "daily_delta": ex_daily,
        })
        if aug3_streams is not None:
            aug3_writes.append({
                "track_ref": int(ref), "date": AUG3,
                "streams": aug3_streams, "daily_delta": new3d,
            })

    aug2_sum = sum(w["streams"] for w in aug2_writes)
    print(f"  aug2 exact streams sum = {aug2_sum:,}")

    if not APPLY:
        print("  DRY RUN — no writes. Set APPLY=1 to apply.")
        return

    for batch in (aug2_writes, aug3_writes):
        for i in range(0, len(batch), 200):
            sb("POST", "/track_daily_stats",
               params={"on_conflict": "track_ref,date"},
               headers={"Prefer": "resolution=merge-duplicates"},
               json=batch[i:i + 200])
    print(f"  ✓ Applied: {len(aug2_writes)} aug2 rows, {len(aug3_writes)} aug3 deltas")


def main():
    print(f"MODE: {'APPLY (writing)' if APPLY else 'DRY RUN (no writes)'}")
    only = os.environ.get("ONLY")  # optional comma-separated artist_id filter
    only_ids = {s.strip() for s in only.split(",")} if only else None
    for artist_id, exact in EXACT.items():
        if only_ids and artist_id not in only_ids:
            continue
        process_artist(artist_id, exact)
    print("\n✓ Done")


if __name__ == "__main__":
    main()
