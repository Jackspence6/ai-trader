"""Alias-table seeds (spec §14.5) — SA leagues first, plus global mainstream."""

TEAM_SEEDS: dict[str, list[str]] = {
    # PSL / Betway Premiership
    "Mamelodi Sundowns": ["Sundowns", "MSFC", "Mamelodi Sundowns FC"],
    "Orlando Pirates": ["Pirates", "OPFC", "Orlando Pirates FC"],
    "Kaizer Chiefs": ["Chiefs", "KC", "Kaizer Chiefs FC", "Amakhosi"],
    "SuperSport United": ["SuperSport", "SSU", "Matsatsantsa"],
    "Stellenbosch FC": ["Stellenbosch", "Stellies"],
    "Sekhukhune United": ["Sekhukhune", "Babina Noko"],
    # URC / Currie Cup
    "Bulls": ["Vodacom Bulls", "Blue Bulls", "Pretoria Bulls"],
    "Sharks": ["Hollywoodbets Sharks", "Natal Sharks", "The Sharks"],
    "Stormers": ["DHL Stormers", "WP Stormers"],
    "Lions": ["Emirates Lions", "Golden Lions"],
    # SA20
    "MI Cape Town": ["MICT", "Mumbai Indians Cape Town"],
    "Sunrisers Eastern Cape": ["SEC", "Sunrisers EC"],
    "Pretoria Capitals": ["Capitals", "Pretoria Caps"],
    "Joburg Super Kings": ["JSK", "Johannesburg Super Kings"],
    "Paarl Royals": ["Royals"],
    "Durban's Super Giants": ["DSG", "Durban Super Giants"],
    # Global mainstream
    "Manchester United": ["Man Utd", "Man United", "MUFC"],
    "Manchester City": ["Man City", "MCFC"],
    "Golden State Warriors": ["Warriors", "GSW", "Golden State"],
    "Los Angeles Lakers": ["Lakers", "LA Lakers", "LAL"],
    "Boston Celtics": ["Celtics", "BOS"],
}

LEAGUE_SEEDS: dict[str, list[str]] = {
    "Betway Premiership": ["PSL", "Premier Soccer League", "SA Premiership", "DStv Premiership"],
    "United Rugby Championship": ["URC", "Vodacom URC", "Vodacom United Rugby Championship"],
    "Currie Cup": ["Carling Currie Cup"],
    "SA20": ["Betway SA20"],
    "Premier League": ["EPL", "English Premier League"],
    "NBA": ["National Basketball Association"],
}
