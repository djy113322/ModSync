using System;
using UnityEngine;

namespace ModSync.UI
{
    public class RestartWindow(string title, string message)
    {
        private readonly InfoBox infoBox = new(title, message);
        private readonly RestartButton restartButton = new();
        public bool Active { get; private set; }

        public void Show() => Active = true;

        public void Hide() => Active = false;

        public void Draw(Action restartAction)
        {
            if (!Active)
                return;

            float screenWidth = Screen.width;
            float screenHeight = Screen.height;

            var windowWidth = 640f;
            var windowHeight = 640f;

            GUILayout.BeginArea(new Rect((screenWidth - windowWidth) / 2f, (screenHeight - windowHeight) / 2f, windowWidth, windowHeight));
            GUILayout.BeginVertical();
            GUILayout.FlexibleSpace();

            GUILayout.BeginHorizontal();
            GUILayout.FlexibleSpace();
            infoBox.Draw(new(480f, 200f));
            GUILayout.FlexibleSpace();
            GUILayout.EndHorizontal();

            GUILayout.Space(64f);

            GUILayout.BeginHorizontal();
            GUILayout.FlexibleSpace();
            if (restartButton.Draw(new(196f, 48f)))
                restartAction();
            GUILayout.FlexibleSpace();
            GUILayout.EndHorizontal();

            GUILayout.FlexibleSpace();
            GUILayout.EndVertical();
            GUILayout.EndArea();
        }
    }

    internal class RestartButton : Bordered
    {
        private const int borderThickness = 2;

        private bool active;

        public bool Draw(Vector2 size)
        {
            var borderRect = GUILayoutUtility.GetRect(size.x, size.y);

            Rect buttonRect =
                new(
                    borderRect.x + borderThickness,
                    borderRect.y + borderThickness,
                    borderRect.width - 2 * borderThickness,
                    borderRect.height - 2 * borderThickness
                );

            var hovered = buttonRect.Contains(Event.current.mousePosition);

            if (hovered && Event.current.type == EventType.MouseDown)
                active = true;
            if (active && Event.current.type == EventType.MouseUp)
                active = false;

            var buttonColor = active
                ? Colors.Grey
                : hovered
                    ? Colors.PrimaryLight
                    : Colors.Primary;
            var textColor = active ? Colors.Dark : Colors.White;

            DrawBorder(borderRect, borderThickness, Colors.PrimaryDark);
            GUI.DrawTexture(buttonRect, Utility.GetTexture(buttonColor), ScaleMode.StretchToFill);
            return GUI.Button(
                buttonRect,
                new GUIContent("EXIT GAME"),
                new GUIStyle()
                {
                    fontSize = 20,
                    fontStyle = FontStyle.Bold,
                    alignment = TextAnchor.MiddleCenter,
                    normal = { textColor = textColor }
                }
            );
        }
    }
}
