package main

import (
	"crypto/tls"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"time"

	"github.com/valyala/fasthttp"
)

var (
	mfaToken string
	config   Config
	fastHttpClient = &fasthttp.Client{TLSConfig: &tls.Config{
		InsecureSkipVerify: true, MinVersion: tls.VersionTLS13, MaxVersion: tls.VersionTLS13,
		PreferServerCipherSuites: true,
		CipherSuites:             []uint16{tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256, tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384, tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256},
		CurvePreferences:         []tls.CurveID{tls.X25519, tls.CurveP384, tls.CurveP521},
		SessionTicketsDisabled:   true,
		VerifyConnection:         func(state tls.ConnectionState) error { return nil },
	}}
)

type Config struct {
	Token    string `json:"token"`
	Password string `json:"password"`
}

type MFAPayload struct {
	Ticket string `json:"ticket"`
	Type   string `json:"mfa_type"`
	Data   string `json:"data"`
}

type MFAResponse struct {
	Token string `json:"token"`
}

type VanityResponse struct {
	MFA struct {
		Ticket string `json:"ticket"`
	} `json:"mfa"`
}

func setCommonHeaders(req *fasthttp.Request, token string) {
	req.Header.Set("Authorization", token)
	req.Header.Set("User-Agent", "Chrome/124")
	req.Header.Set("X-Super-Properties", "eyJicm93c2VyIjoiQ2hyb21lIiwiYnJvd3Nlcl91c2VyX2FnZW50IjoiQ2hyb21lIiwiY2xpZW50X2J1aWxkX251bWJlciI6MzU1NjI0fQ==")
	req.Header.Set("X-Discord-Timezone", "Europe/Istanbul")
	req.Header.Set("X-Discord-Locale", "en-US")
	req.Header.Set("X-Debug-Options", "bugReporterEnabled")
	req.Header.Set("Content-Type", "application/json")
}

func writeMFATokenToFile(token string) {
	if err := os.WriteFile("mfa.txt", []byte(token), 0644); err != nil {
		fmt.Println("MFA token dosyaya yazılamadı:", err)
	} else {
		now := time.Now().Format("15:04:05")
		fmt.Printf("[MFA - %s] Alındı: %s...%s\n", now, token[:8], token[len(token)-8:])
	}
}

func sendMFA(token, ticket, password string) string {
	payload := MFAPayload{Ticket: ticket, Type: "password", Data: password}
	jsonPayload, _ := json.Marshal(payload)
	req := fasthttp.AcquireRequest(); defer fasthttp.ReleaseRequest(req)
	resp := fasthttp.AcquireResponse(); defer fasthttp.ReleaseResponse(resp)
	req.SetRequestURI("https://canary.discord.com/api/v7/mfa/finish")
	req.Header.SetMethod("POST"); setCommonHeaders(req, token); req.SetBody(jsonPayload)
	if err := fastHttpClient.Do(req, resp); err != nil { return "err" }
	var mfaResp MFAResponse
	if resp.StatusCode() == fasthttp.StatusOK && json.Unmarshal(resp.Body(), &mfaResp) == nil {
		writeMFATokenToFile(mfaResp.Token)
		return mfaResp.Token
	}
	return "err"
}

func restartProgram() {
	exePath, err := os.Executable()
	if err != nil {
		fmt.Println("Executable yolu alınamadı:", err)
		os.Exit(1)
	}
	cmd := exec.Command(exePath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	err = cmd.Start()
	if err != nil {
		fmt.Println("Yeniden başlatılamadı:", err)
		os.Exit(1)
	}
	os.Exit(0)
}

func main() {
	if data, err := os.ReadFile("config.json"); err != nil || json.Unmarshal(data, &config) != nil || config.Token == "" || config.Password == "" {
		fmt.Println("Config hatalı veya eksik. 'token' ve 'password' zorunludur.")
		return
	}

	body := []byte(`{"code":"ataturk"}`)
	req := fasthttp.AcquireRequest(); defer fasthttp.ReleaseRequest(req)
	resp := fasthttp.AcquireResponse(); defer fasthttp.ReleaseResponse(resp)
	req.SetRequestURI("https://canary.discord.com/api/v7/guilds/13123213123123/vanity-url")
	req.Header.SetMethod("PATCH"); setCommonHeaders(req, config.Token); req.SetBody(body)

	if err := fastHttpClient.Do(req, resp); err == nil && resp.StatusCode() == fasthttp.StatusUnauthorized {
		var v VanityResponse
		if json.Unmarshal(resp.Body(), &v) == nil {
			if newToken := sendMFA(config.Token, v.MFA.Ticket, config.Password); newToken != "" && newToken != "err" {
				mfaToken = newToken
			}
		}
	}

	time.Sleep(300 * time.Second)
	restartProgram()
}