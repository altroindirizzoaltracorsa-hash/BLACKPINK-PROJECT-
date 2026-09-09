"""Patches track_daily_stats for 2026-08-02 with EXACT per-track stream values
from kworb.net (Last updated: 2026/08/03 = Aug 2 Spotify data).

Replaces the proportional scaling applied by fix-aug-tracks.py.
Run this AFTER fix-aug-tracks.py (which correctly set 2026-08-03 rows).
"""

import os
import sys
import httpx

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]

TARGET_DATE = "2026-08-02"

# kworb.net Last updated: 2026/08/03 = Aug 2 Spotify data
# {track_name: (total_streams, daily_delta)}
KWORB_DATA = {
    "41MozSoPIsD1dJM0CLPjZF": {  # BLACKPINK (113 tracks)
        "How You Like That": (1_271_572_786, 232_215),
        "Kill This Love": (1_055_557_779, 205_892),
        "Pink Venom": (1_024_301_914, 238_421),
        "Shut Down": (901_806_583, 207_863),
        "DDU-DU DDU-DU": (882_286_869, 185_025),
        "As If It's Your Last": (805_615_338, 221_537),
        "Kiss and Make Up": (775_751_901, 135_496),
        "Lovesick Girls": (735_771_720, 162_092),
        "BOOMBAYAH": (718_967_467, 210_096),
        "Ice Cream (with Selena Gomez)": (671_237_485, 87_907),
        "JUMP": (664_256_627, 632_266),
        "Pretty Savage": (591_070_370, 110_459),
        "PLAYING WITH FIRE": (561_722_971, 133_258),
        "WHISTLE": (502_247_821, 114_335),
        "Typa Girl": (481_964_640, 89_395),
        "Forever Young": (445_261_340, 108_399),
        "Sour Candy (with BLACKPINK)": (424_636_835, 48_233),
        "Don't Know What To Do": (365_646_962, 66_012),
        "Tally": (342_916_499, 63_177),
        "Love To Hate Me": (291_842_946, 61_190),
        "STAY": (286_036_247, 56_710),
        "Crazy Over You": (280_928_526, 43_200),
        "Hard to Love": (271_995_944, 49_409),
        "Bet You Wanna (feat. Cardi B)": (222_379_646, 27_545),
        "You Never Know": (206_418_558, 31_249),
        "Really": (197_671_241, 34_257),
        "Kick It": (191_706_149, 32_271),
        "See U Later": (172_950_382, 32_063),
        "THE GIRLS - BLACKPINK THE GAME OST": (166_326_795, 37_594),
        "The Happiest Girl": (165_430_738, 32_023),
        "Ready For Love": (150_999_944, 33_813),
        "Yeah Yeah Yeah": (147_751_465, 27_132),
        "Hope Not": (141_560_208, 20_625),
        "BOOMBAYAH - Japanese Version": (99_544_664, 10_271),
        "DDU-DU DDU-DU - Remix": (94_438_588, 14_127),
        "GO": (94_795_845, 201_316),
        "DDU-DU DDU-DU - Japanese Version": (81_020_848, 9_488),
        "WHISTLE - Acoustic Ver.": (80_527_344, 13_114),
        "SO HOT - THEBLACKLABEL REMIX ARENA TOUR OSAKA": (79_382_456, 10_067),
        "AS IF IT'S YOUR LAST - Japanese Version": (56_028_638, 12_169),
        "FOREVER YOUNG - Japanese Version": (46_509_918, 5_778),
        "WHISTLE - Japanese Version": (46_194_547, 2_799),
        "Champion": (46_995_665, 98_992),
        "PLAYING WITH FIRE - Japanese Version": (43_955_313, 3_204),
        "DDU-DU DDU-DU - Live": (42_686_370, 5_462),
        "SEE U LATER - Japanese Version": (39_737_378, 4_890),
        "REALLY - Japanese Version": (38_266_924, 5_121),
        "STAY - Japanese Version": (38_007_181, 3_058),
        "KILL THIS LOVE - JP Ver.": (37_767_747, 1_982),
        "Kiss and Make Up - ARENA TOUR OSAKA": (33_396_228, 11_882),
        "Me and my": (32_974_546, 3_095),
        "LET IT BE~YOU&I~ONLY LOOK AT ME - ARENA TOUR OSAKA": (24_174_354, 47_179),
        "Fxxxboy": (20_365_179, 1_267),
        "Pretty Savage - JP Ver.": (15_067_621, 1_985),
        "Yuki no Hana/JISOO - LIVE ARENA TOUR OSAKA": (14_138_990, 1_227),
        "DDU-DU DDU-DU - Remix -JP Ver.-": (13_559_550, 12_769),
        "Kill This Love - Live": (12_671_932, 2_570),
        "Pretty Savage - Live": (11_581_039, 1_802),
        "Lovesick Girls - JP Ver.": (11_319_954, 2_233),
        "YOU & I + ONLY LOOK AT ME - Live": (11_060_452, 1_734),
        "Crazy Over You - Live": (10_922_790, 4_445),
        "How You Like That - JP Ver.": (10_810_474, 3_072),
        "DDU-DU DDU-DU - Live (2)": (10_600_695, 1_806),
        "How You Like That - Live": (10_233_712, 1_897),
        "Lovesick Girls - Live": (9_536_542, 967),
        "Sour Candy - Shygirl & Mura Masa Remix": (8_953_006, 1_807),
        "Love To Hate Me + You Never Know - Live": (8_689_889, 1_530),
        "Don't Know What To Do - Live": (8_687_900, 1_043),
        "PLAYING WITH FIRE - Live (2)": (8_641_570, 557),
        "DDU-DU DDU-DU - JP Ver./TOKYO DOME": (7_866_807, 416),
        "WHISTLE - Acoustic Ver. Japanese Version": (7_679_615, 943),
        "Forever Young - Live": (6_936_382, 1_319),
        "BOOMBAYAH - Live": (6_884_988, 728),
        "SOLO - Live": (6_826_241, 1_253),
        "WHISTLE - Live (2)": (6_556_050, 772),
        "Kill This Love - JP Ver./TOKYO DOME": (6_520_690, 1_250),
        "As If It's Your Last - Live (2)": (6_434_966, 943),
        "BOOMBAYAH - Live (2)": (5_747_715, 1_137),
        "Forever Young - Live (2)": (5_738_814, 1_011),
        "Last Christmas/Akahana no Tonakai - ARENA TOUR OSAKA": (5_634_332, 429),
        "DDU-DU DDU-DU (Remix Version) - Live": (5_588_973, 1_853),
        "DON'T KNOW WHAT TO DO - JP Ver.": (5_522_126, 646),
        "FOREVER YOUNG - JP Ver./TOKYO DOME": (5_418_068, 769),
        "PLAYING WITH FIRE - Live (SEOUL)": (5_333_635, 446),
        "STAY (Remix Version) - Live": (5_290_175, 625),
        "WHISTLE (Remix Version) - Live": (5_278_138, 625),
        "Really (Reggae Version) - Live": (5_204_946, 436),
        "As If It's Your Last - Live (SEOUL)": (5_120_000, 544),
        "BOOMBAYAH - JP Ver./TOKYO DOME": (4_998_323, 771),
        "STAY - Live": (4_580_570, 398),
        "WHISTLE - Live (SEOUL)": (4_545_811, 397),
        "Don't Know What To Do - JP Ver./TOKYO DOME": (4_517_441, 532),
        "WHISTLE - JP Ver./TOKYO DOME": (4_360_316, 369),
        "STAY - Remix/JP Ver./TOKYO DOME": (4_208_940, 529),
        "You Never Know - JP Ver.": (4_151_356, 611),
        "HOPE NOT - JP Ver.": (4_145_469, 859),
        "KICK IT - JP Ver.": (4_062_382, 335),
        "DDU-DU DDU-DU - ARENA TOUR OSAKA": (3_996_744, 531),
        "See U Later - Live": (3_961_163, 495),
        "AS IF IT'S YOUR LAST - JP Ver./TOKYO DOME": (3_858_944, 197),
        "Kiss and Make Up (Remix) [Mixed]": (3_644_769, 344),
        "REALLY - JP Ver./TOKYO DOME": (3_631_375, 361),
        "PLAYING WITH FIRE - JP Ver./TOKYO DOME": (3_511_639, 269),
        "Kick It - JP Ver./TOKYO DOME": (3_057_128, 269),
        "SEE U LATER - JP Ver./TOKYO DOME": (3_057_128, 273),
        "BOOMBAYAH - ARENA TOUR OSAKA": (2_994_421, 323),
        "FOREVER YOUNG - ARENA TOUR OSAKA": (2_977_836, 315),
        "WHISTLE - Acoustic Ver. ARENA TOUR OSAKA": (2_796_108, 276),
        "STAY - ARENA TOUR OSAKA": (2_735_482, 287),
        "AS IF IT'S YOUR LAST - ARENA TOUR OSAKA": (2_543_289, 287),
        "PLAYING WITH FIRE - ARENA TOUR OSAKA": (2_387_609, 241),
        "REALLY - ARENA TOUR OSAKA": (2_199_169, 269),
        "SEE U LATER - ARENA TOUR OSAKA": (2_080_823, 256),
    },
    "6UZ0ba50XreR4TM8u322gs": {  # JISOO (12 tracks)
        "FLOWER": (631_066_507, 131_345),
        "earthquake": (192_965_542, 154_918),
        "All Eyes On Me": (188_386_985, 45_325),
        "EYES CLOSED (with ZAYN)": (173_104_519, 170_480),
        "Your Love": (81_689_058, 99_656),
        "Hugs & Kisses": (45_522_593, 53_236),
        "TEARS": (33_047_308, 33_412),
        "earthquake - Sam Feldt remix": (5_124_207, 4_312),
        "EYES CLOSED (with ZAYN) - 2X": (2_003_305, 2_320),
        "EYES CLOSED (with ZAYN) - 0.5X": (1_366_704, 1_386),
        "EYES CLOSED (with ZAYN) - BARE": (1_273_041, 1_599),
        "EYES CLOSED (with ZAYN) - UNVEILED": (584_923, 1_002),
    },
    "250b0Wlc5Vk0CoUsaCY84M": {  # JENNIE (41 tracks)
        "One Of The Girls (with JENNIE, Lily Rose Depp)": (2_767_758_502, 1_638_368),
        "like JENNIE": (911_742_688, 749_703),
        "SOLO": (792_898_224, 145_170),
        "Mantra": (569_233_672, 293_434),
        "Dracula - JENNIE Remix": (448_502_806, 1_605_936),
        "You & Me": (348_983_988, 121_861),
        "ExtraL (feat. Doechii)": (341_289_583, 203_550),
        "SPOT!": (301_673_411, 122_341),
        "Love Hangover (feat. Dominic Fike)": (240_880_419, 164_894),
        "Handlebars (feat. Dua Lipa)": (216_002_017, 226_506),
        "Seoul City": (201_336_505, 249_708),
        "You & Me (Coachella ver.)": (115_589_493, 32_809),
        "ZEN": (108_910_817, 106_445),
        "with the IE (way up)": (106_282_595, 104_539),
        "Damn Right (feat. Childish Gambino & Kali Uchis)": (99_734_722, 98_496),
        "start a war": (79_783_731, 77_258),
        "Black (Feat. JENNIE of BLACKPINK)": (71_156_105, 43_295),
        "Filter": (48_981_286, 50_558),
        "One Of The Girls - Sped Up": (48_201_072, 24_667),
        "Starlight": (47_014_870, 62_934),
        "twin": (46_503_998, 39_539),
        "SOLO - Live": (42_529_239, 14_540),
        "Intro : JANE with FKJ": (35_590_475, 31_834),
        "F.T.S.": (34_408_519, 34_450),
        "Slow Motion": (33_501_560, 15_967),
        "like JENNIE - Extended Remix": (21_445_023, 72_575),
        "Less Than a Lover": (21_336_533, 1_673_837),
        'SOLO - BLACKPINK ARENA TOUR 2018 "SPECIAL FINAL IN KYOCERA DOME OSAKA"': (14_143_103, 7_068),
        "One Of The Girls - Slowed": (14_100_828, 10_205),
        "like JENNIE - Peggy Gou Remix": (13_442_077, 10_262),
        "Special": (12_219_313, 4_901),
        "like JENNIE - EDM Remix": (10_619_218, 21_525),
        "One Of The Girls - Instrumental": (7_434_809, 8_268),
        "ExtraL - Just JENNIE": (5_808_206, 13_467),
        "Damn Right - Just JENNIE": (5_482_095, 17_539),
        "One Of The Girls - A Cappella": (5_099_470, 6_808),
        "Handlebars - Just JENNIE": (3_464_086, 54_217),
        "Dracula - JENNIE Remix - Boys Noize Disko Version": (2_945_867, 14_895),
        "Love Hangover - Just JENNIE": (2_907_459, 9_216),
        "like JENNIE - Peggy Gou Remix - EXTENDED MIX": (780_438, 493),
        "Dracula - JENNIE Remix Instrumental": (498_452, 1_044),
    },
    "3eVa5w3URK5duf6eyVDbu9": {  # ROSE (18 tracks)
        "APT.": (2_570_408_256, 1_368_113),
        "On The Ground": (590_309_519, 97_253),
        "Gone": (471_129_663, 101_382),
        "toxic till the end": (463_997_789, 340_851),
        "number one girl": (354_264_655, 248_560),
        "Messy (From F1® The Movie)": (192_298_736, 185_211),
        "On My Mind": (142_779_877, 128_928),
        "drinks or coffee": (139_109_161, 100_443),
        "stay a little longer": (110_880_164, 101_186),
        "Without You (Feat. ROSE)": (104_764_170, 40_676),
        "3am": (95_073_458, 88_069),
        "two years": (94_032_413, 75_162),
        "gameboy": (91_473_473, 58_444),
        "too bad for us": (57_877_150, 42_935),
        "dance all night": (56_732_388, 48_629),
        "call it the end": (47_432_814, 37_054),
        "not the same": (46_395_709, 25_967),
        "Gone - Live": (30_604_858, 5_141),
    },
    "5L1lO4eRHmJ7a0Q6csE5cT": {  # LISA (31 tracks)
        "MONEY": (1_427_577_890, 189_584),
        "LALISA": (647_712_828, 106_661),
        "Rockstar": (618_800_167, 333_970),
        "Moonlit Floor (Kiss Me)": (434_830_361, 150_615),
        "New Woman (feat. ROSALÍA)": (415_243_371, 130_953),
        "Born Again (feat. Doja Cat & RAYE)": (382_552_728, 187_659),
        "SG (with Ozuna, Megan Thee Stallion & LISA of BLACKPINK)": (350_570_741, 51_937),
        "Shoong! (feat. LISA of BLACKPINK)": (222_152_007, 45_800),
        "FXCK UP THE WORLD (feat. Future)": (111_434_599, 46_813),
        "Priceless (feat. LISA)": (104_528_036, 57_272),
        "Dream": (99_428_466, 118_925),
        "Chill": (74_505_917, 45_536),
        "When I'm With You (feat. Tyla)": (59_664_709, 34_983),
        "Rockstar - Extended": (58_188_272, 16_567),
        "Bad Angel (with LISA)": (53_710_233, 156_096),
        "FXCK UP THE WORLD (Vixi Solo Version)": (51_916_962, 39_809),
        "Lifestyle": (51_041_050, 36_787),
        "Elastigirl": (40_221_013, 34_025),
        "Thunder": (40_179_872, 27_468),
        "Goals": (36_451_164, 201_346),
        "Rapunzel (feat. Megan Thee Stallion)": (24_652_016, 13_585),
        "BADGRRRL": (20_984_168, 14_336),
        "Rapunzel (Kiki Solo Version)": (16_201_835, 10_521),
        "Rockstar - Sped Up": (12_385_341, 1_446),
        "Moonlit Floor (Kiss Me) - Santa Baby Remix": (11_956_887, 804),
        "Rockstar - Instrumental": (11_461_218, 1_515),
        "Rockstar - Slowed Down": (10_226_010, 1_330),
        "Moonlit Floor (Kiss Me) - Live Performance Version": (6_199_762, 948),
        "Born Again (feat. Doja Cat & RAYE) - Purple Disco Machine Remix": (5_944_313, 3_600),
        "Moonlit Floor (Kiss Me) - Instrumental": (2_113_135, 166),
        "Born Again (feat. Doja Cat & RAYE) - Purple Disco Machine Extended Mix": (427_715, 252),
    },
}

ARTIST_NAMES = {
    "41MozSoPIsD1dJM0CLPjZF": "BLACKPINK",
    "6UZ0ba50XreR4TM8u322gs": "JISOO",
    "250b0Wlc5Vk0CoUsaCY84M": "JENNIE",
    "3eVa5w3URK5duf6eyVDbu9": "ROSE",
    "5L1lO4eRHmJ7a0Q6csE5cT": "LISA",
}

EXPECTED_KWORB_TOTALS = {
    "41MozSoPIsD1dJM0CLPjZF": 17_595_602_852,
    "6UZ0ba50XreR4TM8u322gs": 1_356_134_692,
    "250b0Wlc5Vk0CoUsaCY84M": 8_200_235_274,
    "3eVa5w3URK5duf6eyVDbu9": 5_659_564_253,
    "5L1lO4eRHmJ7a0Q6csE5cT": 5_403_262_786,
}


def sb(method, path, **kwargs):
    headers = {
        "Authorization": f"Bearer {SUPABASE_KEY}",
        "apikey": SUPABASE_KEY,
        "Content-Type": "application/json",
        **kwargs.pop("headers", {}),
    }
    r = httpx.request(
        method, f"{SUPABASE_URL}/rest/v1{path}",
        headers=headers, timeout=30, **kwargs,
    )
    if r.is_error:
        print(f"  ERROR {r.status_code}: {r.text}", file=sys.stderr)
    r.raise_for_status()
    return r.json() if r.content else None


def main():
    total_matched = 0
    total_missed = 0
    total_upserted = 0

    for artist_id, kworb_tracks in KWORB_DATA.items():
        name = ARTIST_NAMES[artist_id]
        print(f"\n=== {name} ===")

        # Fetch all artist_tracks for this artist
        db_tracks = sb("GET", "/artist_tracks", params={
            "artist_id": f"eq.{artist_id}",
            "select": "id,name",
        })
        name_to_ref = {r["name"]: r["id"] for r in (db_tracks or [])}
        print(f"  DB tracks: {len(name_to_ref)}")

        # Validate kworb total
        kworb_sum = sum(s for s, _ in kworb_tracks.values())
        expected = EXPECTED_KWORB_TOTALS.get(artist_id, 0)
        diff = kworb_sum - expected
        print(f"  Kworb sum: {kworb_sum:,}  expected: {expected:,}  diff: {diff:+,}")

        # Build upsert rows
        rows = []
        missed = []
        for track_name, (streams, daily) in kworb_tracks.items():
            ref = name_to_ref.get(track_name)
            if ref is None:
                missed.append(track_name)
                continue
            rows.append({
                "track_ref": ref,
                "date": TARGET_DATE,
                "streams": streams,
                "daily_delta": daily,
            })

        if missed:
            print(f"  UNMATCHED ({len(missed)}):")
            for m in missed:
                print(f"    - {m!r}")
        total_missed += len(missed)

        # Upsert in batches of 200
        for i in range(0, len(rows), 200):
            sb(
                "POST", "/track_daily_stats",
                params={"on_conflict": "track_ref,date"},
                headers={"Prefer": "resolution=merge-duplicates"},
                json=rows[i:i + 200],
            )
        print(f"  Upserted {len(rows)} rows for {TARGET_DATE}")
        total_matched += len(rows)
        total_upserted += len(rows)

    print(f"\n=== DONE ===")
    print(f"  Upserted: {total_upserted}  Unmatched: {total_missed}")
    if total_missed:
        print("  WARNING: some tracks were unmatched — check names above", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
