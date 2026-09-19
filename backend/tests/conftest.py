"""Test harness for the Flask track.

Each test gets a throwaway SQLite database seeded exactly the way a fresh
install is, so the suite exercises the real init_db()/seed path rather than a
hand-built fixture schema. DATABASE_URL is cleared deliberately: a developer
with production credentials in their shell must never have the tests point at
the restaurant's live database.
"""

import os
import sys
import uuid

import pytest

BACKEND_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, BACKEND_DIR)


# Production runs on Postgres, so the suite can run there too. Point
# TEST_DATABASE_URL at a *disposable* local cluster (see tests/README.md) and
# every test gets its own freshly created database on it:
#
#   TEST_DATABASE_URL=postgres://postgres@localhost:55432/postgres pytest
#
# Without it the suite runs on SQLite, which needs no setup.
TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "").strip()


def _fresh_postgres_database():
    """Create a throwaway database on the test cluster and return its URL."""
    import psycopg

    name = "nl_test_" + uuid.uuid4().hex[:12]
    with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as admin:
        admin.execute(f'CREATE DATABASE "{name}"')
        # Default the session to UTC on purpose: that is what the production
        # transaction pooler leaves in place, and every timezone-dependent
        # result must still come out in the restaurant's own clock.
        admin.execute(f"ALTER DATABASE \"{name}\" SET TimeZone TO 'UTC'")
    head, _, _ = TEST_DATABASE_URL.rpartition("/")
    return f"{head}/{name}", name


def _drop_postgres_database(name):
    import psycopg

    try:
        with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as admin:
            admin.execute(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)')
    except Exception:  # noqa: BLE001 - a leftover test database is harmless
        pass


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.delenv("RENDER", raising=False)
    monkeypatch.delenv("PRODUCTION", raising=False)
    monkeypatch.setenv("PASSWORD_HASH_METHOD", "pbkdf2:sha256:1")

    created = None
    if TEST_DATABASE_URL:
        url, created = _fresh_postgres_database()
        monkeypatch.setenv("DATABASE_URL", url)
    else:
        monkeypatch.delenv("DATABASE_URL", raising=False)
        monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))

    for module in ("app", "database"):
        sys.modules.pop(module, None)
    import app as app_module

    app_module.app.config["TESTING"] = True
    try:
        with app_module.app.test_client() as test_client:
            test_client.app_module = app_module
            yield test_client
    finally:
        try:
            import database

            if database._pg_pool is not None:
                database._pg_pool.close()
                database._pg_pool = None
        except Exception:  # noqa: BLE001
            pass
        if created:
            _drop_postgres_database(created)


def login(client, username="admin", password="nextlevel@123"):
    res = client.post("/api/login", json={"username": username, "password": password})
    assert res.status_code == 200, res.get_json()
    return res.get_json()["data"]


def data(res):
    body = res.get_json()
    assert body is not None, res.data[:400]
    assert body.get("success"), body
    return body.get("data")


def first_food_item(client):
    return data(client.get("/api/food/items"))[0]


def first_alcohol_item(client):
    return data(client.get("/api/alcohol/items"))[0]


def new_ref():
    return uuid.uuid4().hex
