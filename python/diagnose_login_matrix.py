"""Independent, read-only login/download-page probes for the Trigger production image."""

import json
import os
import sys
from datetime import timedelta
from html.parser import HTMLParser

BASE = "https://www.consorcioservopa.com.br"
LOGIN = f"{BASE}/vendas/login"
DOWNLOADS = f"{BASE}/vendas/downloads"
PROFILES = {
    "firefox_135": ("Firefox135", "firefox135"),
    "firefox_147": ("Firefox147", "firefox147"),
    "firefox_149": ("Firefox149", None),
    "chrome_131": ("Chrome131", "chrome131"),
    "chrome_142": ("Chrome142", "chrome142"),
    "chrome_145": ("Chrome145", "chrome145"),
    "edge_101": ("Edge101", "edge101"),
    "safari_18": ("Safari18", "safari180"),
}
VERSIONS = ("profile", "HTTP1", "HTTP2")


class HiddenInputs(HTMLParser):
    def __init__(self):
        super().__init__()
        self.values = {}

    def handle_starttag(self, tag, attrs):
        if tag != "input":
            return
        values = dict(attrs)
        if values.get("type", "").lower() == "hidden" and values.get("name"):
            self.values[values["name"]] = values.get("value", "")


def form_for(html):
    parser = HiddenInputs()
    parser.feed(html)
    return {**parser.values, "cpf_cnpj": os.environ["SERVOPA_CPF_CNPJ"],
            "senha": os.environ["SERVOPA_SENHA"], "tipo": "1", "btn_representante": ""}


def run_cffi(profile, version, repetition):
    from curl_cffi import CurlHttpVersion
    from curl_cffi.requests import Session

    result = base_result("curl_cffi", profile, version, repetition)
    http_version = (CurlHttpVersion.V1_1 if version == "HTTP1" else
                    CurlHttpVersion.V2_0 if version == "HTTP2" else None)
    with Session(impersonate=PROFILES[profile][1]) as client:
        try:
            init = client.get(LOGIN, timeout=25, http_version=http_version)
            result["loginInitStatus"] = init.status_code
            if init.status_code != 200:
                return result
            posted = client.post(LOGIN, data=form_for(init.text), timeout=25,
                                 http_version=http_version,
                                 headers={"Upgrade-Insecure-Requests": "1"})
            result["loginPostStatus"] = posted.status_code
            result["redirectedToDashboard"] = posted.status_code == 200 and "/dashboard" in posted.url
            if result["redirectedToDashboard"]:
                result["downloadsStatus"] = client.get(DOWNLOADS, timeout=25,
                                                        http_version=http_version).status_code
        except Exception as exc:
            result["error"] = type(exc).__name__
    return result


def run_wreq(profile, version, repetition):
    from wreq.blocking import Client
    from wreq.emulation import Emulation

    result = base_result("wreq-python", profile, version, repetition)
    options = {"emulation": getattr(Emulation, PROFILES[profile][0]),
               "timeout": timedelta(seconds=25)}
    if version != "profile":
        options["http1_only"] = version == "HTTP1"
        options["http2_only"] = version == "HTTP2"
    client = Client(**options)
    try:
        init = client.get(LOGIN)
        result["loginInitStatus"] = init.status.as_int()
        if result["loginInitStatus"] != 200:
            return result
        posted = client.post(LOGIN, form=form_for(init.text()),
                             headers={"Upgrade-Insecure-Requests": "1"})
        result["loginPostStatus"] = posted.status.as_int()
        result["redirectedToDashboard"] = result["loginPostStatus"] == 200 and "/dashboard" in str(posted.url)
        if result["redirectedToDashboard"]:
            result["downloadsStatus"] = client.get(DOWNLOADS).status.as_int()
    except Exception as exc:
        result["error"] = type(exc).__name__
    finally:
        client.close()
    return result


def base_result(client, profile, version, repetition):
    return {"client": client, "profile": profile, "httpVersion": version,
            "repetition": repetition, "variant": "baseline",
            "loginInitStatus": None, "loginPostStatus": None,
            "redirectedToDashboard": False, "downloadsStatus": None, "error": None}


def main():
    if sys.argv[1:] == ["--self-test"]:
        parser = HiddenInputs()
        parser.feed('<input type="hidden" name="csrf" value="a&amp;b"><input name="x" value="y">')
        assert parser.values == {"csrf": "a&b"}
        print("ok")
        return
    repetitions = int(sys.argv[1])
    results = []
    for repetition in range(1, repetitions + 1):
        for profile in PROFILES:
            for version in VERSIONS:
                for probe in (run_cffi, run_wreq) if PROFILES[profile][1] else (run_wreq,):
                    results.append(probe(profile, version, repetition))
    print(json.dumps(results))


if __name__ == "__main__":
    main()
