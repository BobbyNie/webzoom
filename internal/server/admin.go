package server

import (
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"webzoom/internal/auth"
)

func (a *app) administrator(next protected) http.HandlerFunc {
	return a.secure(func(w http.ResponseWriter, r *http.Request, s *auth.Session) {
		if !a.admins[s.User.ID] {
			http.Error(w, "administrator access required", http.StatusForbidden)
			return
		}
		next(w, r, s)
	})
}

func (a *app) endRooms(w http.ResponseWriter, r *http.Request, s *auth.Session) {
	var body struct {
		RoomIDs []string `json:"roomIds"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(&body) != nil || d.Decode(new(any)) != io.EOF || len(body.RoomIDs) == 0 || len(body.RoomIDs) > 100 {
		http.Error(w, "invalid room selection", http.StatusBadRequest)
		return
	}
	for _, id := range body.RoomIDs {
		decoded, err := base64.RawURLEncoding.Strict().DecodeString(id)
		if err != nil || len(id) != 32 || len(decoded) != 24 {
			http.Error(w, "invalid room selection", http.StatusBadRequest)
			return
		}
	}
	reply(w, http.StatusOK, map[string]any{"results": a.Hub.EndRooms(body.RoomIDs)})
}

func (a *app) setBandwidth(w http.ResponseWriter, r *http.Request, s *auth.Session) {
	var body struct {
		LimitMbps int `json:"limitMbps"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if d.Decode(&body) != nil || d.Decode(new(any)) != io.EOF {
		http.Error(w, "invalid bandwidth configuration", http.StatusBadRequest)
		return
	}
	status, err := a.Hub.SetBandwidthLimit(body.LimitMbps)
	if err != nil {
		fail(w, err)
		return
	}
	reply(w, http.StatusOK, status)
}
