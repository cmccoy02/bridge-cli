from click.testing import CliRunner

from pg_cli import cli, greet


def test_greet():
    assert greet("world") == "Hello, world!"


def test_cli_outputs_greeting():
    result = CliRunner().invoke(cli, ["world"])
    assert result.exit_code == 0
    assert "Hello, world!" in result.output
