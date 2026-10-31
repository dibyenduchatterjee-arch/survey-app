"""The single geopoint parser: the rules intake, OpenRosa and the CSV export all share."""

import pytest

from app.intake.geopoint import GeopointError, parse_geopoint


def test_all_four_parts_are_read():
    g = parse_geopoint("25.6123 85.1456 -12.5 4.5")
    assert (g.lat, g.lon, g.altitude, g.accuracy) == (25.6123, 85.1456, -12.5, 4.5)
    assert g.tokens == ("25.6123", "85.1456", "-12.5", "4.5")


def test_altitude_and_accuracy_are_optional():
    g = parse_geopoint("25.6 85.1")
    assert (g.altitude, g.accuracy) == (None, None)
    assert parse_geopoint("25.6 85.1 7").accuracy is None


@pytest.mark.parametrize(
    "bad",
    ["", "somewhere", "25.6", "a b", "1 2 3 4 5", "95 85", "-91 85", "25 190", "25 -181", "25 85 abc 4",
     "25 85 1 -2", "nan 85", "25 inf", "25 85 1e999", "0x10 85", "1_0 85", "25,6 85,1"],
)
def test_anything_else_is_refused(bad):
    with pytest.raises(GeopointError):
        parse_geopoint(bad)


def test_a_non_string_is_refused():
    for bad in (None, 25.6, ["25", "85"], {"lat": 1, "lon": 2}):
        with pytest.raises(GeopointError):
            parse_geopoint(bad)


def test_boundaries_are_valid_and_zero_accuracy_is_valid():
    assert parse_geopoint("90 180 0 0").accuracy == 0.0
    assert parse_geopoint("-90 -180").lat == -90.0
