import click
from rich.console import Console

console = Console()


def greet(name: str) -> str:
    return f"Hello, {name}!"


@click.command()
@click.argument("name")
def cli(name: str) -> None:
    console.print(greet(name))


if __name__ == "__main__":
    cli()
